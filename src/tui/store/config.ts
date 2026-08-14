import { TCombinedStore } from "./index";
import { Config, fetchConfig, findMirror, Mirror } from "../../api/data/config";
import Label from "../../labels";
import { attempt } from "../../utilities";
import { Adapter } from "../../api/adapters/adapter";
import { getAdapter } from "../../api/adapters";
import { getDocument } from "../../api/data/document";
import { MirrorCandidate } from "../../api/data/resolve";
import { SEARCH_PAGE_SIZE } from "../../settings";
import { MirrorCheckStatus } from "./app";

export interface IConfigState extends Config {
  mirrorAdapter: Adapter | undefined;
  mirror: Mirror | undefined;
  // Last mirror that actually served a file. MD5s in one list usually come
  // from a single catalogue, so trying that mirror first keeps the per item
  // probe cost of a long list close to zero.
  preferredMirrorSource: string | undefined;
  unreachableMirrorSources: string[];
  fetchConfig: () => Promise<void>;
  switchMirror: (
    onMirrorStatus: (mirror: string, status: MirrorCheckStatus) => void
  ) => Promise<boolean>;
  setPreferredMirrorSource: (mirrorSource: string | undefined) => void;
  markMirrorUnreachable: (mirrorSource: string) => void;
  getMirrorCandidates: () => MirrorCandidate[];
}

export const initialConfigState: Omit<
  IConfigState,
  | "fetchConfig"
  | "switchMirror"
  | "setPreferredMirrorSource"
  | "markMirrorUnreachable"
  | "getMirrorCandidates"
> = {
  mirrorAdapter: undefined,
  latestVersion: "",
  mirrors: [],
  mirror: undefined,
  preferredMirrorSource: undefined,
  unreachableMirrorSources: [],
};

export const createConfigStateSlice = (
  set: (
    partial: Partial<TCombinedStore> | ((state: TCombinedStore) => Partial<TCombinedStore>)
  ) => void,
  get: () => TCombinedStore
) => ({
  ...initialConfigState,

  fetchConfig: async () => {
    const store = get();

    store.setIsLoading(true);
    store.setLoaderMessage(Label.FETCHING_CONFIG);

    const config = await attempt(fetchConfig);

    if (!config) {
      store.setIsLoading(false);
      store.setErrorMessage("Couldn't fetch the config");
      return;
    }

    // Find an available mirror
    store.setLoaderMessage(Label.FINDING_MIRROR);
    const mirror = await findMirror(config.mirrors, (failedMirror: string) => {
      store.setLoaderMessage(
        `${Label.COULDNT_REACH_TO_MIRROR}, ${failedMirror}. ${Label.FINDING_MIRROR}`
      );
    });
    store.setIsLoading(false);

    if (!mirror) {
      store.setErrorMessage("Couldn't find a working mirror");
      return;
    }

    const mirrorAdapter = getAdapter(mirror.src, mirror.type);

    set({
      ...config,
      mirror,
      mirrorAdapter,
    });
  },

  switchMirror: async (
    onMirrorStatus: (mirror: string, status: MirrorCheckStatus) => void
  ): Promise<boolean> => {
    const store = get();
    const currentMirrorSource = store.mirror?.src;
    const otherMirrors = store.mirrors.filter((m) => m.src !== currentMirrorSource);

    if (otherMirrors.length === 0) {
      return false;
    }

    for (const mirror of otherMirrors) {
      onMirrorStatus(mirror.src, "checking");

      try {
        const adapter = getAdapter(mirror.src, mirror.type);
        const testURL = adapter.getSearchURL("test", 1, SEARCH_PAGE_SIZE);
        const result = await getDocument(testURL);
        const connectionError = adapter.detectConnectionError(result.document);

        if (connectionError) {
          onMirrorStatus(mirror.src, "failed");
          continue;
        }

        // Mirror works — switch to it
        onMirrorStatus(mirror.src, "ok");
        set({ mirror, mirrorAdapter: adapter });
        get().resetEntryCacheMap();
        return true;
      } catch {
        onMirrorStatus(mirror.src, "failed");
      }
    }

    return false;
  },

  setPreferredMirrorSource: (mirrorSource: string | undefined) => {
    const store = get();

    set({
      preferredMirrorSource: mirrorSource,
      unreachableMirrorSources: store.unreachableMirrorSources.filter(
        (source) => source !== mirrorSource
      ),
    });
  },

  markMirrorUnreachable: (mirrorSource: string) => {
    const store = get();

    if (store.unreachableMirrorSources.includes(mirrorSource)) {
      return;
    }

    set({
      unreachableMirrorSources: [...store.unreachableMirrorSources, mirrorSource],
    });
  },

  getMirrorCandidates: (): MirrorCandidate[] => {
    const store = get();

    const orderedMirrors: Mirror[] = [];
    const pushMirror = (mirror: Mirror | undefined) => {
      if (!mirror) {
        return;
      }

      if (orderedMirrors.some((existing) => existing.src === mirror.src)) {
        return;
      }

      orderedMirrors.push(mirror);
    };

    pushMirror(store.mirrors.find((mirror) => mirror.src === store.preferredMirrorSource));
    pushMirror(store.mirror);
    for (const mirror of store.mirrors) {
      pushMirror(mirror);
    }

    const candidates: MirrorCandidate[] = [];
    for (const mirror of orderedMirrors) {
      if (mirror.src === store.mirror?.src && store.mirrorAdapter) {
        candidates.push({ mirror, adapter: store.mirrorAdapter });
        continue;
      }

      try {
        candidates.push({ mirror, adapter: getAdapter(mirror.src, mirror.type) });
      } catch {
        // A mirror type this build doesn't know about is simply not a candidate.
      }
    }

    const reachableCandidates = candidates.filter(
      (candidate) => !store.unreachableMirrorSources.includes(candidate.mirror.src)
    );

    // Everything failed at some point during this run. Trying them all again
    // beats failing every remaining item outright.
    if (reachableCandidates.length === 0) {
      return candidates;
    }

    return reachableCandidates;
  },
});
