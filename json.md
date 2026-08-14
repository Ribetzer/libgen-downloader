## API

The API returns data in json format in the context of objects, receiving a request from the user via GET to this page, in parts no more than 10,000 records ( [For more information about the structure of the database, see .](https://libgen.li/community/viewtopic.php?f=3&t=31)).

Mandatory parameter _object_ \- allowed values: a, s, p, e, f, w (respectively - authors, series, publishers, editions, files, works).

Optional parameter _limit1, limit2_ \- if _limit1_ is filled, then it returns the first _limit1_ records, if _limit1 is filled_, _limit2_, returns _limit2_ records starting from _limit1_ record.

Optional parameter _ids_ \- ID we get information on specific records in the corresponding _object_, can be listed separated by commas.

Optional parameter _mode_ \- records view mode - can take values ​​ _last, modified_ (last added or modified, respectively)

Optional parameter _timefirst, timelast_ \- the range of the start and end time of adding or modifying a record (depending on _mode_) in YYYY-MM-DD format.

Optional parameter _id\_start, id\_end_ \- the range of id records of the corresponding objects.

Optional parameter _fields_ \- a list of fields received from the main objects tables, by default \*, the full list of objects is given below.

Optional parameter _addkeys_ \- list of additional keys. description fields, displayed in the _add_ subarray, can be separated by commas, to get everything - specify \*, the full list of objects is given below.

Optional parameter _topic_ \- LG repository, to get data on files by id, respectively. repositories, not a common file id (valid values: l, c, m, a, s, f, r (corresponding libgen, comics, magazines, articles, standards, fiction, rus. fiction))

For some objects, additional subarrays of related objects are displayed (in the mode when data on specific objects is requested through the _ids_ parameter):

for _editions_: _files_ and _works_;

for _files_: _editions_;

for _series_: _editions_ and _works_;

for _works_: _editions_;

for _authors_: _editions_ and _works_;

for _publishers_: _editions_ and _series_

Examples of:

Show all fields of all files added from 2018-09-02 to 2018-09-04

[/json.php?object=f&mode=last&timefirst=2018-09-02&timelast=2018-09-04](https://libgen.li/json.php?object=f&mode=last&timefirst=2018-09-02&timelast=2018-09-04)

Show fields md5, filesize of files with id> 85000000 in scimag repository by first 1000 records

[/json.php?object=f&id\_start=85000000&fields=md5,filesize&topic=a&limit1=0&limit2=1000](https://libgen.li/json.php?object=f&id_start=85000000&fields=md5,filesize&topic=a&limit1=0&limit2=1000)

Show fields all fields of editions with id = 1,6,800 + additional fields with keys 101 (language), 308 (publisher)

[/json.php?object=e&ids=1,6,800&fields=\*&addkeys=101,308](https://libgen.li/json.php?object=e&ids=1,6,800&fields=*&addkeys=101,308)

Show title field of edition with doi=10.2307/3762753 + all add. fields

[/json.php?object=e&doi=10.2307/3762753&fields=title&addkeys=\*](https://libgen.li/json.php?object=e&doi=10.2307/3762753&fields=title&addkeys=*)

## List of optional description fields

| **Key** | **Name** | **Type** | **Add. attribute 1** | **Add. attribute 2** | **Add. attribute 3** | **For editions** | **For works** | **For publishers** | **For files** | **For series** | **For authors** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | Main Title on original language | str |  |  |  | X |  |  |  | X |  |
| 11 | Main Title on english transcription | str |  |  |  |  |  | X |  | X | X |
| 12 | Main Title variant | str | Language |  |  |  |  | X |  | X |  |
| 13 | Main Title on english translate | str |  |  |  | X |  |  |  | X |  |
| 14 | Title in Russian | str |  |  |  | X |  |  |  |  |  |
| 16 | Abbreviations of Main Title | str |  |  |  |  |  | X |  | X |  |
| 17 | CODEN | str |  |  |  |  |  |  |  | X |  |
| 20 | Container title | str |  |  |  | X |  |  |  |  |  |
| 40 | Title addition | str |  |  |  |  |  |  |  | X |  |
| 50 | Subtitle | str |  |  |  |  |  |  |  | X |  |
| 60 | Overtitle | str |  |  |  |  |  |  |  | X |  |
| 101 | Language | lst |  |  |  | X |  |  |  | X | X |
| 102 | Language original | lst |  |  |  | X |  |  |  |  |  |
| 120 | DOI Prefix | str |  |  |  |  |  |  |  | X |  |
| 201 | Periodicity, Frequency | str |  |  |  |  |  |  |  | X |  |
| 202 | Periodicity, Frequency in year | num | Year |  |  |  |  |  |  | X |  |
| 301 | Place (state) | str | City | Adress |  |  |  | X |  | X |  |
| 302 | Publisher | str |  |  |  |  |  |  |  | X |  |
| 303 | Publisher imprint | str |  |  |  |  |  | X |  | X |  |
| 304 | Corporate contributor | str |  |  |  |  |  |  |  | X |  |
| 305 | ISBN Publisher code | str | Commentary |  |  |  |  | X |  |  |  |
| 306 | Site | url |  |  |  | X | X | X |  | X | X |
| 307 | Publisher Logo | img |  |  |  |  |  | X |  |  |  |
| 308 | Publisher ID | lnk | Name variant |  |  | X |  |  |  | X |  |
| 309 | Other links | url | Site ID |  |  | X |  | X |  | X |  |
| 310 | Imprint ID | lnk |  |  |  |  |  | X |  |  |  |
| 311 | ISFDB Publisher ID | num |  |  |  |  |  | X |  |  |  |
| 312 | Fantlab Publisher ID | num |  |  |  |  |  | X |  |  |  |
| 313 | Livelib Publisher ID | num |  |  |  |  |  | X |  |  |  |
| 314 | USSR publishers code | num | Commentary |  |  |  |  | X |  |  |  |
| 315 | Parent Publisher | lnk |  |  |  |  |  | X |  |  |  |
| 316 | Document submitted by CIS organization | str |  |  |  | X |  |  |  |  |  |
| 317 | The document was accepted by the CIS organization | str |  |  |  | X |  |  |  |  |  |
| 318 | Interstate TC | str |  |  |  | X |  |  |  |  |  |
| 319 | TC number to which the document is assigned | str |  |  |  | X |  |  |  |  |  |
| 320 | Organization - Developer | str |  |  |  | X |  |  |  |  |  |
| 321 | MND developer | str |  |  |  | X |  |  |  |  |  |
| 322 | Associated countries | str |  |  |  | X |  |  |  |  |  |
| 401 | Author | str | Role | Library | Library ID | X |  |  |  |  |  |
| 402 | Author ID | lnk | Role | Variant (pseudonim) |  | X | X | X |  | X |  |
| 410 | VIAF ID | str |  |  |  |  |  |  |  |  | X |
| 411 | ISFDB Author ID | num |  |  |  |  |  |  |  |  | X |
| 412 | email | str |  |  |  |  |  |  |  |  | X |
| 413 | Alternate Name / Pseudonim. Family | str | Name | Surname | Language |  |  |  |  |  | X |
| 414 | Author Image | img |  |  |  |  |  |  |  |  | X |
| 415 | Translator | str |  |  |  |  | X |  |  |  |  |
| 416 | Related Authors | lnk |  |  |  |  |  |  |  |  | X |
| 501 | ISSN | str | Type |  |  | X |  |  |  | X |  |
| 505 | ISBN | str | ISBN notes |  |  | X |  |  |  |  |  |
| 601 | Topic. Magz | lst |  |  |  |  |  |  |  | X |  |
| 602 | UDC | str |  |  |  | X |  |  |  | X |  |
| 603 | DDC | str |  |  |  | X |  |  |  | X |  |
| 604 | Topic. Comics | lst |  |  |  | X |  |  |  | X |  |
| 605 | Topic. Journals | lst |  |  |  |  |  |  |  | X |  |
| 606 | Topic. Books | lst |  |  |  | X |  |  |  |  |  |
| 607 | Standard type | lst | Standart number | Standart date |  | X |  |  |  |  |  |
| 608 | Standart number | str |  |  |  | X |  |  |  |  |  |
| 609 | Parent document | str |  |  |  | X |  |  |  |  |  |
| 610 | Formerly known as, Continues | lnk |  |  |  |  |  |  |  | X |  |
| 611 | Continued as | lnk |  |  |  |  |  |  |  | X |  |
| 612 | Supplement to | lnk |  |  |  |  |  |  |  | X |  |
| 613 | Incorporated in, Merged with | lnk |  |  |  |  |  |  |  | X |  |
| 614 | Formerly part of, Separated from | lnk |  |  |  |  |  |  |  | X |  |
| 615 | Including, Absorbed | lnk |  |  |  |  |  |  |  | X |  |
| 616 | Has a relation with | lnk |  |  |  |  |  |  |  | X |  |
| 617 | Incorporating, Formed by the union of | lnk |  |  |  |  |  |  |  | X |  |
| 618 | Formerly included in | lnk |  |  |  |  |  |  |  | X |  |
| 619 | Included in | lnk |  |  |  |  |  |  |  | X |  |
| 620 | Translation of | lnk |  |  |  |  |  |  |  | X |  |
| 621 | Translated as | lnk |  |  |  |  |  |  |  | X |  |
| 622 | Absorbed in part by | lnk |  |  |  |  |  |  |  | X |  |
| 623 | Has supplement | lnk |  |  |  |  |  |  |  | X |  |
| 624 | Continues in part | lnk |  |  |  |  |  |  |  | X |  |
| 625 | Continued in part by | lnk |  |  |  |  |  |  |  | X |  |
| 626 | Superseded by | lnk |  |  |  |  |  |  |  | X |  |
| 627 | Supersedes | lnk |  |  |  |  |  |  |  | X |  |
| 628 | Supersedes in part | lnk |  |  |  |  |  |  |  | X |  |
| 629 | Parent series | lnk | Position |  |  |  |  |  |  | X |  |
| 630 | Series | str | Number | Library | Library ID | X |  | X |  |  |  |
| 631 | Series ID | lnk | # | Name variant |  | X | X |  |  |  |  |
| 632 | Replaced in part | str |  |  |  | X |  |  |  |  |  |
| 633 | Related to | str |  |  |  | X |  |  |  |  |  |
| 634 | Related in | str |  |  |  | X |  |  |  |  |  |
| 635 | Replaced to | str |  |  |  | X |  |  |  |  |  |
| 636 | Replaced to part | str |  |  |  | X |  |  |  |  |  |
| 637 | Replaced in | str |  |  |  | X |  |  |  |  |  |
| 638 | Publishing info | str |  |  |  | X |  |  |  |  |  |
| 639 | LBC | str |  |  |  | X |  |  |  |  |  |
| 640 | Authentic text | str |  |  |  | X |  |  |  |  |  |
| 641 | Harmonized with | str |  |  |  | X |  |  |  |  |  |
| 642 | Documents that can be modified (supplemented) by data | str |  |  |  | X |  |  |  |  |  |
| 643 | Documents changing (supplementing) this | str |  |  |  | X |  |  |  |  |  |
| 644 | Index of the GRNTI rubricator | str |  |  |  | X |  |  |  |  |  |
| 645 | Code KS (OKS, IСS) | str |  |  |  | X |  |  |  |  |  |
| 646 | OKSTU code | str |  |  |  | X |  |  |  |  |  |
| 647 | International Classification for Standards ICS | str |  |  |  | X |  |  |  |  |  |
| 648 | Use on the territory of the Russian Federation | str |  |  |  | X |  |  |  |  |  |
| 649 | Normative references to | str |  |  |  | X |  |  |  |  |  |
| 650 | Number of the order to assign the document to the TC | str |  |  |  | X |  |  |  |  |  |
| 651 | Protocol number | str |  |  |  | X |  |  |  |  |  |
| 652 | The validity period has been removed | str |  |  |  | X |  |  |  |  |  |
| 653 | Canceled in part | str |  |  |  | X |  |  |  |  |  |
| 654 | Cross references | str |  |  |  | X |  |  |  |  |  |
| 655 | Contains requirements | str |  |  |  | X |  |  |  |  |  |
| 656 | Technical Committee of Russia | str |  |  |  | X |  |  |  |  |  |
| 657 | TK – standard developer | str |  |  |  | X |  |  |  |  |  |
| 658 | Rostekhregulirovaniya Department | str |  |  |  | X |  |  |  |  |  |
| 701 | Published in a collection/magazine | str |  |  |  | X |  |  |  |  |  |
| 750 | Standart status | str | Additional Standart status |  |  | X |  |  |  |  |  |
| 770 | Awards | lst | Year |  |  | X | X | X |  | X | X |
| 801 | Official site | url |  |  |  |  |  |  |  | X |  |
| 803 | Series Logo | img |  |  |  |  |  |  |  | X |  |
| 820 | Date publication | str |  |  |  | X |  |  |  |  |  |
| 821 | Date introduction | str |  |  |  | X |  |  |  |  |  |
| 822 | Date actualization text | str |  |  |  | X |  |  |  |  |  |
| 823 | Date registration | str |  |  |  | X |  |  |  |  |  |
| 824 | Date actualization descr | str |  |  |  | X |  |  |  |  |  |
| 825 | Date expiration | str |  |  |  | X |  |  |  |  |  |
| 826 | Date last edition | str |  |  |  | X |  |  |  |  |  |
| 827 | Date limit validity period | str |  |  |  | X |  |  |  |  |  |
| 828 | Last edition date | str |  |  |  | X |  |  |  |  |  |
| 829 | Date of the order to assign the document to the TC | str |  |  |  | X |  |  |  |  |  |
| 830 | Date of admission to MGU | str |  |  |  | X |  |  |  |  |  |
| 850 | TTH | str |  |  |  |  |  |  | X |  |  |
| 851 | SHA1 | str |  |  |  |  |  |  | X |  |  |
| 852 | SHA256 | str |  |  |  |  |  |  | X |  |  |
| 853 | CRC32 | str |  |  |  |  |  |  | X |  |  |
| 854 | eDonkey | str |  |  |  |  |  |  | X |  |  |
| 855 | AICH | str |  |  |  |  |  |  | X |  |  |
| 856 | BTIH | str |  |  |  |  |  |  | X |  |  |
| 860 | Archive content | str | MD5 Content |  |  |  |  |  | X |  |  |
| 861 | Library | str | Issue | Filename |  |  |  |  | X |  |  |
| 863 | Cover url | img | Cover Name | Creator(s) | Sidebar Location | X |  |  |  |  |  |
| 864 | Librusec book ID | num |  |  |  |  |  |  | X |  |  |
| 865 | Flibusta book ID | num |  |  |  |  |  |  | X |  |  |
| 866 | Coollib book ID | num |  |  |  |  |  |  | X |  |  |
| 867 | Maxima book ID | num |  |  |  |  |  |  | X |  |  |
| 868 | Traum book ID | num | Path |  |  |  |  |  | X |  |  |
| 869 | Litmir book ID | num |  |  |  |  |  |  | X |  |  |
| 870 | Changes history | str |  |  |  |  |  |  | X |  |  |
| 871 | Scene release name | str | Release date |  |  |  |  |  | X |  |  |
| 872 | Librusec author ID | num |  |  |  |  |  |  |  |  | X |
| 873 | Flibusta author ID | num |  |  |  |  |  |  |  |  | X |
| 874 | Maxima author ID | num |  |  |  |  |  |  |  |  | X |
| 875 | Traum author ID | num |  |  |  |  |  |  |  |  | X |
| 876 | Litmir author ID | num |  |  |  |  |  |  |  |  | X |
| 877 | IPFS CID | str |  |  |  |  |  |  | X |  |  |
| 878 | Flibusta series ID | num |  |  |  |  |  |  |  | X |  |
| 879 | Librusec series ID | num |  |  |  |  |  |  |  | X |  |
| 880 | Maxima series ID | num |  |  |  |  |  |  |  | X |  |
| 881 | Litmir series ID | num |  |  |  |  |  |  |  | X |  |
| 882 | Traum series ID | num |  |  |  |  |  |  |  | X |  |
| 883 | ЕКот ID | str |  |  |  | X |  |  |  |  |  |
| 884 | Magzdb book ID | num |  |  |  | X |  |  |  |  |  |
| 901 | Parent DOI | str | Chapter number |  |  | X |  |  |  | X |  |
| 902 | PII | str |  |  |  | X |  |  |  |  |  |
| 903 | PMC ID | str |  |  |  | X |  |  |  |  |  |
| 904 | PMID | str |  |  |  | X |  |  |  |  |  |
| 905 | ArXiv | str |  |  |  | X |  |  |  | X |  |
| 906 | Scopus ID | str |  |  |  | X |  |  |  | X |  |
| 907 | Crossref Journal ID | str |  |  |  |  |  |  |  | X |  |
| 908 | ASIN | str |  |  |  | X |  |  |  |  |  |
| 909 | BL | str |  |  |  | X |  |  |  |  |  |
| 910 | BNB | str |  |  |  | X |  |  |  |  |  |
| 911 | BNF | str |  |  |  | X |  |  |  |  |  |
| 912 | COPAC | str |  |  |  | X |  |  |  |  |  |
| 913 | DNB | str |  |  |  | X |  |  |  |  |  |
| 914 | FantLab Edition ID | num |  |  |  | X |  |  |  |  |  |
| 915 | Goodreads | str |  |  |  | X |  |  |  |  |  |
| 916 | JNB/JPNO | str |  |  |  | X |  |  |  |  |  |
| 917 | LCCN | str |  |  |  | X |  |  |  |  |  |
| 918 | NDL | str |  |  |  | X |  |  |  |  |  |
| 919 | OCLC/WorldCat | num |  |  |  | X |  |  |  |  |  |
| 920 | Open Library | str |  |  |  | X |  |  |  |  |  |
| 921 | SFBG | str |  |  |  | X |  |  |  |  |  |
| 922 | BN | str |  |  |  | X |  |  |  |  |  |
| 923 | PPN | str |  |  |  | X |  |  |  |  |  |
| 924 | Audible-ASIN | str |  |  |  | X |  |  |  |  |  |
| 925 | LTF | str |  |  |  | X |  |  |  |  |  |
| 926 | KBR | str |  |  |  | X |  |  |  |  |  |
| 927 | Reginald-1 | str |  |  |  | X |  |  |  |  |  |
| 928 | Reginald-3 | str |  |  |  | X |  |  |  |  |  |
| 929 | Bleiler Gernsback | str |  |  |  | X |  |  |  |  |  |
| 930 | Bleiler Supernatural | str |  |  |  | X |  |  |  |  |  |
| 931 | Bleiler Early Years | str |  |  |  | X |  |  |  |  |  |
| 932 | NILF | str |  |  |  | X |  |  |  |  |  |
| 933 | NooSFere | str |  |  |  | X |  |  |  |  |  |
| 934 | SF-Leihbuch | str |  |  |  | X |  |  |  |  |  |
| 935 | NLA | str |  |  |  | X |  |  |  |  |  |
| 936 | PORBASE | str |  |  |  | X |  |  |  |  |  |
| 937 | MagzDB series ID | num |  |  |  |  |  |  |  | X |  |
| 938 | ISFDB Series ID | num |  |  |  |  |  |  |  | X |  |
| 939 | ISFDB Pub series ID | num |  |  |  |  |  |  |  | X |  |
| 940 | ISFDB Title ID (works) | num |  |  |  |  | X |  |  |  |  |
| 941 | RSL ID | str |  |  |  | X |  |  |  |  |  |
| 943 | ISFDB Pub ID (editions) | num |  |  |  | X |  |  |  |  |  |
| 944 | Springer series ID | num |  |  |  |  |  |  |  | X |  |
| 945 | GoogleBookID | str |  |  |  | X |  |  |  |  |  |
| 946 | JSTOR Stable ID | num |  |  |  | X |  |  |  |  |  |
| 947 | Crossref Book ID | url |  |  |  | X |  |  |  |  |  |
| 948 | SGR ID | str |  |  |  | X |  |  |  |  |  |
| 949 | PUI ID | str |  |  |  | X |  |  |  |  |  |
| 950 | Classification | str |  |  |  | X |  |  |  |  |  |
| 951 | Classification OKP | str |  |  |  | X |  |  |  |  |  |
| 952 | Classification GOST group | str |  |  |  | X |  |  |  |  |  |
| 953 | Classification OKS | str |  |  |  | X |  |  |  |  |  |
| 954 | Library of Congress Classification | str |  |  |  | X |  |  |  |  |  |
| 989 | Sci-Hub notes | str | comment |  |  |  |  |  | X |  |  |
| 990 | Tags | str |  |  |  | X | X | X |  | X |  |
| 991 | Site ID | str |  |  |  |  |  |  |  | X |  |
| 992 | Issues & years | str |  |  |  |  |  |  |  | X |  |
| 993 | Type of requirements | str |  |  |  | X |  |  |  |  |  |
| 995 | Table of contents | txt |  |  |  | X | X |  |  |  |  |
| 996 | Description | txt |  |  |  | X |  | X |  | X | X |
| 997 | Mark21 Record | xml |  |  |  |  |  |  |  | X |  |
| 998 | Series Type | lst |  |  |  |  |  |  |  |  |  |
| 999 | Notes | txt |  |  |  | X | X | X |  | X | X |

## List of valid keys and fields for LG objects

| **Objects** | **Keys for search** | **Fields** |
| --- | --- | --- |
| f (Files) | id\_start, id\_end, ids, timelast, timefirst, md5, tth, sha1, sha256, crc32, edonkey, aich, btih | f\_id, md5, pages, dpi, visible, time\_added, time\_last\_modified, cover\_exists, commentary, color, cleaned, orientation, paginated, scanned, vector, bookmarked, ocr, filesize, extension, locator, broken, editable, generic, cover\_info, file\_create\_date, archive\_files\_count, archive\_dop\_files\_flag, archive\_files\_pic\_count, scan\_type, scan\_content, c2c, scan\_quality, releaser, libgen\_id, fiction\_id, fiction\_rus\_id, comics\_id, scimag\_id, standarts\_id, magz\_id, libgen\_topic, scan\_size, scimag\_archive\_path |
| e (Editions) | id\_start, id\_end, ids, timelast, timefirst, doi, isbn, dois | e\_id, title, libgen\_topic, type, series\_name, title\_add, author, publisher, city, edition, year, month, day, pages, editions\_add\_info, cover\_url, issue\_s\_id, issue\_number\_in\_year, issue\_year\_number, issue\_number, issue\_volume, issue\_split, issue\_total\_number, issue\_first\_page, issue\_last\_page, issue\_year\_end, issue\_month\_end, issue\_day\_end, issue\_closed, doi, time\_added, time\_last\_modified, visible, editable, commentary, cover\_exists |
| s (Series) | id\_start, id\_end, ids, timelast, timefirst | s\_id, libgen\_topic, title, add\_info, type, volume, volume\_type, volume\_name, publisher, commentary, date\_start, date\_end, time\_last\_modified, time\_added, visible, editable |
| a (Authors) | id\_start, id\_end, ids, timelast, timefirst | a\_id, family, name, surname, canonical\_name, add\_info, type, birth\_date, death\_date, birth\_place, debut\_date, time\_added, time\_last\_modified, commentary, editable, visible |
| p (Publishers) | id\_start, id\_end, ids, timelast, timefirst | p\_id, title, org\_type, add\_info, time\_added, time\_last\_modified, date\_start, date\_end, visible, editable, commentary |
| w (Works) | id\_start, id\_end, ids, timelast, timefirst | w\_id, title, add\_info, work\_type, date, language, parent\_w\_id, title\_storylen, time\_added, time\_last\_modified, visible, editable, commentary |