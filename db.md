# New Database structure published / Опубликована новая структура Базы данных

by [admin](http://libgen.bz/community/memberlist.php?mode=viewprofile&u=2)

_In English:_

The general approach to the formation of a new database structure is based on the division of technical data into files and bibliographic descriptions of books, as well as the formation of a full-fledged normalized bibliographic database.

In accordance with this approach, the main tables are highlighted:

_Editions_ \- bibliographic information about printed or electronic publications;

_Files_\- technical data about files;

_Works_ \- works - information about the works of a particular author in isolation from their particular edition, there is also information about translations of the original work;

These tables are joined through crosstabs editions\_to\_files, works\_to\_editions, which provides a many-to-many relationship.

To normalize the descriptions, reference tables are highlighted:

_Authors_ \- authors;

_Publishers_\- publishing houses;

_Series_ \- series, in the broadest sense of the word (book publishing series, magazines, comics, author's series, etc.);

_\\* \_add\_descr_( _editions\_add\_descr, authors\_add\_descr, etc._) \- for each of the 6 above tables there are tables with additional description elements,

these tables contain description elements, which can be several in one book (for example, ISBN, or publishers), or they are of little significance (IDs of various sites, classifiers, etc.),

which allows you to normalize the description and not change the structure of the main tables

_elem\_descr_ \- structure of description elements for tables \* \_add\_descr;

_descr\_elems_ \- simple reference books (classifiers, languages, etc.) that do not require a complex structure or extended attributes.

_In Russian:_

Общий поход к формированию новй структуры БД основывается на разделении технических данных по файлам и библиографических описаний книг, а так формированию полноценной нормализованной библиографической базы данных.

В соответствии с таким подходом выделяются основные таблицы:

_Editions_ \- библиографическая информация о печатных или электронных изданиях;

_Files_ \- технические данные о файлах;

_Works_\- произведения \- информация о работах конкретного автора в отвязке от их конкретного издания, там же находится информация о переводах исходного произведения;

Объединение этих таблиц происходит через кросс-таблицы editions\_to\_files, works\_to\_editions, что обеспечивает связь многие ко многим.

Для нормализации описаний выделены таблицы-справочники:

_Authors_\- авторы;

_Publishers_\- издательства;

_Series_\- серии, в широком смысле этого слова (книжные издательские серии, журналы, комиксы, авторские серии и т.п.);

_\*\_add\_descr_ ( _editions\_add\_descr, authors\_add\_descr_ и т.п.) \- для каждой из 6 вышеперечисленных таблиц есть таблицы с дополнительными элементами описания,

в танные таблицы заносятся элементы описания, которых может быть у одной книги несколько (Например ISBN, или издательства) или же они являются малозначимыми (ID различных сайтов, классификаторы и т. п.),

что позволяет нормализовывать описание и не изменять структуру основных таблиц

_elem\_descr_ \- структура элементов описания для таблиц \*\_add\_descr;

_descr\_elems_ \- простые справочники (классификаторы, языки и т.п.), не требующие сложноподчиненной структуры или расширенных аттрибутов.

|     |     |     |     |     |
| --- | --- | --- | --- | --- |
| ### **table** | ### **field** | ### **type** | ### **comment\_ru** | ### **comment\_en** |
| **_\`authors\`_** |  |  |  |  |
|  | \`a\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`family\` | varchar(250) | Фамилия (на оригинальном языке) | Surname (in original language) |
|  | \`name\` | varchar(200) | Имя (на оригинальном языке) | Name (in original language) |
|  | \`surname\` | varchar(200) | Отчество (на оригинальном языке) | Middle name (in original language) |
|  | \`canonical\_name\` | varchar(300) | Каноничное имя (на оригинальном языке) | Canonical name (in original language) |
|  | \`add\_info\` | varchar(100) | Доп. инфо., для отличия | Add. info., to distinguish |
|  | \`type\` | varchar(1) | тип \- компания \- c, физ лицо - p | type - company - c, individual - p |
|  | \`birth\_date\` | date | Дата рождения | Date of Birth |
|  | \`death\_date\` | date | Дата Смерти | Date of death |
|  | \`birth\_place\` | varchar(200) | Место рождения | Place of Birth |
|  | \`debut\_date\` | year(4) | Дебют | Debut |
|  | \`time\_added\` | datetime | Дата добавления | Date added |
|  | \`time\_last\_modified\` | datetime | Дата последнего изменения | Last modified date |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
|  | \`commentary\` | varchar(250) | Технический комментарий | Technical comment |
|  | \`editable\` | tinyint(1) | Редактируемая запись | Editable entry |
|  | \`visible\` | varchar(3) | Видимый, если не пусто, то указывает по каким причинам \- cpr - абуза, del- удален физически, no - прочие причины | Visible, if not empty, indicates for what reasons - cpr - abuse, del - removed physically, no - other reasons |
| **_\`authors\_add\_descr\`_** |  |  |  |  |
|  | \`a\_add\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`a\_id\` | int(10) | Ссылка на таблицу \`authors\` | Reference to table \`authors\` |
|  | \`key\` | int(10) | Ссылка на элемент описания \- таблица \`elem\_descr\` | Description element reference - table \`elem\_descr\` |
|  | \`value\` | mediumtext | Значение | Meaning |
|  | \`value\_add1\` | mediumtext | Значение1 | Value1 |
|  | \`value\_add2\` | mediumtext | Значение2 | Value2 |
|  | \`value\_add3\` | mediumtext | Значение3 | Value3 |
|  | \`value\_hash\` | bigint(20) | Хеш полей "значение", для проверки совокупности полей на уникальность | Hash of "value" fields, to check a set of fields for uniqueness |
|  | \`date\_start\` | date | Дата С | Date From |
|  | \`date\_end\` | date | Дата По | Date To |
|  | \`issue\_start\` | varchar(45) | Начальное издание, при наличие issue\_able в elem\_descr | Initial edition, with issue\_able in elem\_descr |
|  | \`issue\_end\` | varchar(45) | Конечное издание, при наличие issue\_able в elem\_descr | Final edition, if there is an issue\_able in elem\_descr |
|  | \`time\_added\` | timestamp | Дата добавления | Date added |
|  | \`time\_last\_modified\` | timestamp | Дата последнего изменения | Last modified date |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
|  | \`commentary\` | varchar(45) | Технический комментарий | Technical comment |
| **_\`editions\`_** |  |  |  |  |
|  | \`e\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`libgen\_topic\` | enum | Раздел LG (a - статьи, s - стандарты, l - либген, r - русская худ. лит, f - худ. Лит. , m - журналы, c - комиксы) | Section LG (a - articles, s - standards, l - libgen, r - Russian art.Lit, f - art.Lit., M - magazines, c - comics) |
|  | \`type\` | enum | Тип (b-книга, mon-монография, ch- глава и т.п., см. descr\_elems для \`type\`= edition\_type ) | Type (b-book, mon-monograph, ch-chapter, etc., see descr\_elems for \`type\` = edition\_type) |
|  | \`series\_name\` | varchar(500) | Серия (не нормализованная) | Series (not normalized) |
|  | \`title\` | varchar(2000) | Заголовок издания или подзаголовок для периодических изданий, заголовок статьи или главы | Edition title or subtitle for periodicals, article or chapter title |
|  | \`title\_add\` | varchar(200) | Дополнение к заглавию | Title addition |
|  | \`author\` | varchar(2000) | Автор (не нормализованный) | Author (not normalized) |
|  | \`publisher\` | varchar(1000) | Издательтво (не нормализованное) | Publisher (not normalized) |
|  | \`city\` | varchar(200) | Город | Town |
|  | \`edition\` | varchar(250) | Издание | Edition |
|  | \`year\` | varchar(45) | Год | Year |
|  | \`month\` | enum | Месяц | Month |
|  | \`day\` | varchar(2) | День | Day |
|  | \`pages\` | varchar(100) | Страницы (библиографич.) | Pages (bibliographic) |
|  | \`editions\_add\_info\` | varchar(500) | Доп. информация об издании (формат, вес, тип обложки и т.п.) | Add. edition information (size, weight, cover type, etc.) |
|  | \`cover\_url\` | varchar(450) | Ссылка на обложку со стороннего сайта (если перекачена в LG, то затирается, cover\_url становится равной 1) | Link to the cover from a third-party site (if uploaded to LG, it is overwritten, cover\_url becomes equal to 1) |
|  | \`cover\_exists\` | tinyint(1) | Наличие обложки в репозитории lg editions | Cover in the lg editions repository |
|  | \`issue\_s\_id\` | int(11) | Ссылка на таблицу \`series\` (для периодических изданий) | Link to table \`series\` (for periodicals) |
|  | \`issue\_number\_in\_year\` | int(10) | Техническая нумерация в году для сортировки при формировании таблицы подшивки (для периодических изданий) | Technical numbering per year for sorting when forming a filing table (for periodicals) |
|  | \`issue\_year\_number\` | varchar(45) | Номер за год (для периодических изданий) | Annual issue (for periodicals) |
|  | \`issue\_number\` | varchar(95) | Номер выпуска (в рамках тома) (для периодических изданий) | Issue number (within the volume) (for periodicals) |
|  | \`issue\_volume\` | varchar(45) | Том (для периодических изданий) | Volume (for periodicals) |
|  | \`issue\_split\` | int(10) | Признак того, что номер сдвоен, 0-не сдвоен, 1,2,3 - с каким числом номеров сдвоен (для периодических изданий) | A sign that the number is doubled, 0 is not doubled, 1,2,3 - how many numbers are doubled (for periodicals) |
|  | \`issue\_total\_number\` | varchar(45) | Сквозная нумерация всей подшивки (для периодических изданий) | Continuous numbering of the entire binder (for periodicals) |
|  | \`issue\_first\_page\` | varchar(45) | Начальная страница (для периодических изданий: глав, статей) | Start page (for periodicals: chapters, articles) |
|  | \`issue\_last\_page\` | varchar(45) | Конечная страница (для периодических изданий: глав, статей) | Final page (for periodicals: chapters, articles) |
|  | \`issue\_year\_end\` | varchar(4) | Конечный год, заполняется если номер сдвоенный или приходится на границу 2-х годов (для периодических изданий) | End year, filled in if the number is double or falls on the border of 2 years (for periodicals) |
|  | \`issue\_month\_end\` | enum | Конечный год, заполняется если номер сдвоенный или приходится на границу 2-х годов (для периодических изданий) | End year, filled in if the number is double or falls on the border of 2 years (for periodicals) |
|  | \`issue\_day\_end\` | varchar(2) | Конечный день, заполняется если номер сдвоенный или приходится на границу 2-х годов (для периодических изданий) | End day, to be filled in if the number is double or falls on the border of 2 years (for periodicals) |
|  | \`issue\_closed\` | int(1) | Если номер нe издавался 0, иначе=1 (для формирования таблицы подшивки) (для периодических изданий) | If the issue was not published 0, otherwise = 1 (to form a binder table) (for periodicals) |
|  | \`doi\` | varchar(200) | DOI | DOI |
|  | \`full\_text\` | longtext | Вычисляемое поле для полнотекстового поиска (сейчас не используется) | Calculated field for full-text search (currently not used) |
|  | \`time\_added\` | timestamp | Дата добавления | Date added |
|  | \`time\_last\_modified\` | timestamp | Дата последнего изменения | Last modified date |
|  | \`visible\` | varchar(3) | Видимый, если не пусто, то указывает по каким причинам \- cpr - абуза, del- удален физически, no - прочие причины | Visible, if not empty, then indicates for what reasons - cpr - abuse, del - physically deleted, no - other reasons |
|  | \`editable\` | tinyint(1) | Возможность редактирования пользователями | User editable |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
|  | \`commentary\` | varchar(200) | Технический комментарий | Technical comment |
| _**\`editions\_add\_descr\`**_ |  |  |  |  |
|  | \`e\_add\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`e\_id\` | int(10) | Ссылка на таблицу \`editions\` | Link to table \`editions\` |
|  | \`key\` | int(10) | Ссылка на описание elem\_descr | Link to description elem\_descr |
|  | \`value\` | mediumtext | Значение | Meaning |
|  | \`value\_add1\` | mediumtext | Значение1 | Value1 |
|  | \`value\_add2\` | mediumtext | Значение2 | Value2 |
|  | \`value\_add3\` | mediumtext | Значение3 | Value3 |
|  | \`value\_hash\` | bigint(20) | Хеш полей "значение", для проверки совокупности полей на уникальность | Hash of "value" fields, to check a set of fields for uniqueness |
|  | \`date\_start\` | date | Дата С | Date From |
|  | \`date\_end\` | date | Дата По | Date To |
|  | \`issue\_start\` | varchar(45) | Начальное издание, при наличие issue\_able в elem\_descr | Initial edition, with issue\_able in elem\_descr |
|  | \`issue\_end\` | varchar(45) | Конечное издание, при наличие issue\_able в elem\_descr | Final edition, if there is an issue\_able in elem\_descr |
|  | \`time\_added\` | timestamp | Дата добавления | Date added |
|  | \`time\_last\_modified\` | timestamp | Дата последнего изменения | Last modified date |
|  | \`commentary\` | varchar(1000) | Технический комментарий | Technical comment |
|  | \`uid\` | int(11) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
|  | \`value\_id\` | bigint(20) | Техническое поле, хранит числовые значения поля \`value\` | Technical field, stores the numeric values ​​of the \`value\` field |
| **_\`files\`_** |  |  |  |  |
|  | \`f\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`md5\` | varchar(32) | MD5 хеш файла | MD5 file hash |
|  | \`pages\` | int(10) | Техническое количество страниц в скане | Technical number of pages in a scan |
|  | \`dpi\` | varchar(45) | Разрешение | Permission |
|  | \`visible\` | varchar(3) | Видимый, если не пусто, то указывает по каким причинам \- cpr - абуза, del- удален физически, no - прочие причины | Visible, if not empty, then indicates for what reasons - cpr - abuse, del - physically deleted, no - other reasons |
|  | \`time\_added\` | datetime | Дата добавления | Date added |
|  | \`time\_last\_modified\` | datetime | Дата последнего изменения | Last modified date |
|  | \`cover\_url\` | varchar(255) | Ссылка на обложку | Cover link |
|  | \`cover\_exists\` | tinyint(1) | Существует обложка в репозитории LG для файлов (извлеченная из файла) | There is a cover art in the LG repository for files (extracted from the file) |
|  | \`commentary\` | varchar(1000) | Доп. инфо о скане (fixed и пр.) | Add. scan info (fixed, etc.) |
|  | \`color\` | enum('Y','N','') | Цветной | Color |
|  | \`cleaned\` | enum('Y','N','') | Очищенный скан | Cleaned scan |
|  | \`orientation\` | enum('P','L','') | Ориентация скана \- Портретная, Ландшафтная | Scan orientation - Portrait, Landscape |
|  | \`paginated\` | enum('Y','N','') | Разворот разрезан на страницы | The spread is cut into pages |
|  | \`scanned\` | enum('Y','N','') | Сканированный | Scanned |
|  | \`vector\` | enum('Y','N','') | Векторный | Vector |
|  | \`bookmarked\` | enum('Y','N','') | Есть оглавление | There is a table of contents |
|  | \`ocr\` | enum('Y','N','') | Есть текстовый слой | There is a text layer |
|  | \`filesize\` | int(10) | Размер файла | file size |
|  | \`extension\` | varchar(45) | Расширение | Extension |
|  | \`locator\` | varchar(500) | Имя файла (до загрузки в репозиторий) | File name (before uploading to the repository) |
|  | \`broken\` | enum('Y','N','') | Битый | Broken |
|  | \`editable\` | tinyint(1) | Запись редактируемая | Editable record |
|  | \`generic\` | char(32) | Ссылка на лучшую версию файла | Link to the best version of the file |
|  | \`cover\_info\` | varchar(200) | Информация об обложках (если их несколько) | Cover information (if there are several) |
|  | \`file\_create\_date\` | datetime | Техническая дата создания файла | Technical date of file creation |
|  | \`archive\_files\_count\` | int(10) | Количество файлов в архиве | The number of files in the archive |
|  | \`archive\_dop\_files\_flag\` | enum('Y','N','') | Наличие доп. файлов кроме картинок, для cbr, cbz, rar, zip, 7z | Availability of add. files except pictures, for cbr, cbz, rar, zip, 7z |
|  | \`archive\_files\_pic\_count\` | int(10) | Количество картинок в архиве | Number of pictures in the archive |
|  | \`scan\_type\` | varchar(45) | Тип скана \- цифровой, веб, бумажный скан, микропленка | Scan type - digital, web, paper scan, microfilm |
|  | \`scan\_content\` | varchar(145) | Содержимое скана | Scan content |
|  | \`c2c\` | enum('Y','N','') | Наличие рекламы в скане (c2c) | The presence of advertising in the scan (c2c) |
|  | \`scan\_quality\` | varchar(45) | Качество скана (HQ, Q10) | Scan quality (HQ, Q10) |
|  | \`releaser\` | varchar(125) | Автор релиза | Release author |
|  | \`libgen\_id\` | int(10) | ID репозитория (формирование файловой структуры, тысячных папок) | Repository ID (formation of file structure, thousandths of folders) |
|  | \`fiction\_id\` | int(10) | ID репозитория (формирование файловой структуры, тысячных папок) | Repository ID (formation of file structure, thousandths of folders) |
|  | \`fiction\_rus\_id\` | int(10) | ID репозитория (формирование файловой структуры, тысячных папок) | Repository ID (formation of file structure, thousandths of folders) |
|  | \`comics\_id\` | int(10) | ID репозитория (формирование файловой структуры, тысячных папок) | Repository ID (formation of file structure, thousandths of folders) |
|  | \`scimag\_id\` | int(10) | ID репозитория (формирование файловой структуры, тысячных папок) | Repository ID (formation of file structure, thousandths of folders) |
|  | \`standarts\_id\` | int(10) | ID репозитория (формирование файловой структуры, тысячных папок) | Repository ID (formation of file structure, thousandths of folders) |
|  | \`magz\_id\` | int(10) | ID репозитория (формирование файловой структуры, тысячных папок) | Repository ID (formation of file structure, thousandths of folders) |
|  | \`libgen\_topic\` | enum | правильный раздел для файла | correct section for file |
|  | \`scan\_size\` | varchar(45) | размер рандомной картинки из архива | the size of the random image from the archive |
|  | \`scimag\_archive\_path\` | varchar(1000) | Путь в архиве (для статей) | Archive path (for articles) |
|  | \`scimag\_archive\_path\_is\_doi\` | tinyint(1) | Путь в архиве соответствует doi в \`editions\`, сейчас не используется | Archive path corresponds to doi in \`editions\`, currently not used |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
| **_\`files\_add\_descr\`_** |  |  |  |  |
|  | \`f\_add\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`f\_id\` | int(10) | Ссылка на таблицу \`files\` | Link to table \`files\` |
|  | \`key\` | int(10) | Ссылка на описание elem\_descr | Link to description elem\_descr |
|  | \`value\` | mediumtext | Значение | Meaning |
|  | \`value\_add1\` | mediumtext | Значение1 | Value1 |
|  | \`value\_add2\` | mediumtext | Значение2 | Value2 |
|  | \`value\_add3\` | mediumtext | Значение3 | Value3 |
|  | \`value\_hash\` | bigint(20) | Хеш полей "значение", для проверки совокупности полей на уникальность | Hash of "value" fields, to check a set of fields for uniqueness |
|  | \`date\_start\` | date | Дата С | Date From |
|  | \`date\_end\` | date | Дата По | Date To |
|  | \`issue\_start\` | varchar(45) | Начальное издание, при наличие issue\_able в elem\_descr | Initial edition, with issue\_able in elem\_descr |
|  | \`issue\_end\` | varchar(45) | Конечное издание, при наличие issue\_able в elem\_descr | Final edition, if there is an issue\_able in elem\_descr |
|  | \`time\_added\` | timestamp | Дата добавления | Date added |
|  | \`time\_last\_modified\` | timestamp | Дата последнего изменения | Last modified date |
|  | \`commentary\` | varchar(250) | Технический комментарий | Technical comment |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
| **_\`publishers\`_** |  |  |  |  |
|  | \`p\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`title\` | varchar(500) | Название | Name |
|  | \`org\_type\` | varchar(100) | Вид организации | Organization type |
|  | \`add\_info\` | varchar(45) | Доп. информация (для различия издательств с одинаковыми названиями) | Add. information (to distinguish publishers with the same name) |
|  | \`time\_added\` | datetime | Дата добавления | Date added |
|  | \`time\_last\_modified\` | datetime | Дата последнего изменения | Last modified date |
|  | \`date\_start\` | date | Дата С | Date From |
|  | \`date\_end\` | date | Дата По | Date To |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
|  | \`visible\` | varchar(3) | Видимый, если не пусто, то указывает по каким причинам \- cpr - абуза, del- удален физически, no - прочие причины | Visible, if not empty, then indicates for what reasons - cpr - abuse, del - physically deleted, no - other reasons |
|  | \`editable\` | tinyint(1) | Редактируемая запись | Editable entry |
|  | \`commentary\` | varchar(45) | Технический комментарий | Technical comment |
| **_\`publishers\_add\_descr\`_** |  |  |  |  |
|  | \`p\_add\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`p\_id\` | int(10) | Ссылка на таблицу \`publishers\` | Link to table \`publishers\` |
|  | \`key\` | int(10) | Ссылка на описание elem\_descr | Link to description elem\_descr |
|  | \`value\` | mediumtext | Значение | Meaning |
|  | \`value\_add1\` | mediumtext | Значение1 | Value1 |
|  | \`value\_add2\` | mediumtext | Значение2 | Value2 |
|  | \`value\_add3\` | mediumtext | Значение3 | Value3 |
|  | \`value\_hash\` | bigint(20) | Хеш полей "значение", для проверки совокупности полей на уникальность | Hash of "value" fields, to check a set of fields for uniqueness |
|  | \`date\_start\` | date | Дата С | Date From |
|  | \`date\_end\` | date | Дата По | Date To |
|  | \`issue\_start\` | varchar(45) | Начальное издание, при наличие issue\_able в elem\_descr | Initial edition, with issue\_able in elem\_descr |
|  | \`issue\_end\` | varchar(45) | Конечное издание, при наличие issue\_able в elem\_descr | Final edition, if there is an issue\_able in elem\_descr |
|  | \`time\_added\` | timestamp | Дата добавления | Date added |
|  | \`time\_last\_modified\` | timestamp | Дата последнего изменения | Last modified date |
|  | \`commentary\` | varchar(250) | Технический комментарий | Technical comment |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
| **_\`series\`_** |  |  |  |  |
|  | \`s\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`libgen\_topic\` | enum | Раздел LG | LG section |
|  | \`title\` | varchar(500) | Заголовок серии | Series title |
|  | \`add\_info\` | varchar(100) | Доп. информация (для различия серий с одинаковыми названиями) | Add. information (to distinguish series with the same name) |
|  | \`type\` | varchar(3) | Тип серии \- mag - журнал com - комикс и т.п. | Series type - mag - com magazine - comics, etc. |
|  | \`volume\` | varchar(20) | Том | Volume |
|  | \`volume\_type\` | varchar(50) | Тип серии \- HS, INT, Annual, OS и т. п. | Series type - HS, INT, Annual, OS, etc. |
|  | \`volume\_name\` | varchar(200) | Название тома | Volume name |
|  | \`publisher\` | varchar(1000) | Издательство | Publisher |
|  | \`commentary\` | varchar(250) | Технический комментарий | Technical comment |
|  | \`date\_start\` | date | Дата начала издания | Publication start date |
|  | \`date\_end\` | date | Дата окончания издания | End date of publication |
|  | \`time\_last\_modified\` | datetime | Дата изменения | Date of change |
|  | \`time\_added\` | datetime | Дата добавления | Date added |
|  | \`visible\` | varchar(3) | Видимый, если не пусто, то указывает по каким причинам \- cpr - абуза, del- удален физически, no - прочие причины | Visible, if not empty, then indicates for what reasons - cpr - abuse, del - physically deleted, no - other reasons |
|  | \`editable\` | int(1) | Запрет на редактирование пользователям | Prohibiting users from editing |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
| **_\`series\_add\_descr\`_** |  |  |  |  |
|  | \`s\_add\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`s\_id\` | int(10) | Ссылка на таблицу \`series\` | Reference to table \`series\` |
|  | \`key\` | int(10) | Ссылка на описание elem\_descr | Link to description elem\_descr |
|  | \`value\` | mediumtext | Значение | Meaning |
|  | \`value\_add1\` | mediumtext | Значение1 | Value1 |
|  | \`value\_add2\` | mediumtext | Значение2 | Value2 |
|  | \`value\_add3\` | mediumtext | Значение3 | Value3 |
|  | \`value\_hash\` | bigint(20) | Хеш полей "значение", для проверки совокупности полей на уникальность | Hash of "value" fields, to check a set of fields for uniqueness |
|  | \`date\_start\` | date | Дата С | Date From |
|  | \`date\_end\` | date | Дата По | Date To |
|  | \`issue\_start\` | varchar(45) | Начальное издание, при наличие issue\_able в elem\_descr | Initial edition, with issue\_able in elem\_descr |
|  | \`issue\_end\` | varchar(45) | Конечное издание, при наличие issue\_able в elem\_descr | Final edition, if there is an issue\_able in elem\_descr |
|  | \`time\_added\` | timestamp | Дата добавления | Date added |
|  | \`time\_last\_modified\` | timestamp | Дата последнего изменения | Last modified date |
|  | \`commentary\` | varchar(250) | Технический комментарий | Technical comment |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
| **_\`works\`_** |  |  |  |  |
|  | \`w\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`title\` | varchar(2000) | Заголовок произведения | Title of the work |
|  | \`add\_info\` | varchar(500) | Доп. информация о произведении | Add. product information |
|  | \`work\_type\` | varchar(50) | Тип работы \- роман, рассказ и т.п., ссылка на descr\_elems: work\_type | Work type - novel, story, etc., link to descr\_elems: work\_type |
|  | \`date\` | date | Дата написания | Date of writing |
|  | \`language\` | varchar(3) | Язык, ссылка на descr\_elems (\`type\` = lang) | Language, reference to descr\_elems (\`type\` = lang) |
|  | \`parent\_w\_id\` | int(10) | Ссылка на родительскую работу(для переводных изданий) | Link to parent work (for translated publications) |
|  | \`title\_storylen\` | varchar(45) | Длина произведения | Work length |
|  | \`time\_added\` | datetime | Дата добавления | Date added |
|  | \`time\_last\_modified\` | datetime | Дата последнего изменения | Last modified date |
|  | \`visible\` | varchar(3) | Видимый, если не пусто, то указывает по каким причинам \- cpr - абуза, del- удален физически, no - прочие причины | Visible, if not empty, then indicates for what reasons - cpr - abuse, del - physically deleted, no - other reasons |
|  | \`editable\` | tinyint(1) | Признак редактируемости | Editable attribute |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
|  | \`commentary\` | varchar(100) | Технический комментарий | Technical comment |
| **_\`works\_add\_descr\`_** |  |  |  |  |
|  | \`w\_add\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`w\_id\` | int(10) | Ссылка на таблицу \`works\` | Reference to table \`works\` |
|  | \`key\` | int(10) | Ссылка на описание elem\_descr | Link to description elem\_descr |
|  | \`value\` | mediumtext | Значение | Meaning |
|  | \`value\_add1\` | mediumtext | Значение1 | Value1 |
|  | \`value\_add2\` | mediumtext | Значение2 | Value2 |
|  | \`value\_add3\` | mediumtext | Значение3 | Value3 |
|  | \`value\_hash\` | bigint(20) | Хеш полей "значение", для проверки совокупности полей на уникальность | Hash of "value" fields, to check a set of fields for uniqueness |
|  | \`date\_start\` | date | Дата С | Date From |
|  | \`date\_end\` | date | Дата По | Date To |
|  | \`issue\_start\` | varchar(45) | Начальное издание, при наличие issue\_able в elem\_descr | Initial edition, with issue\_able in elem\_descr |
|  | \`issue\_end\` | varchar(45) | Конечное издание, при наличие issue\_able в elem\_descr | Final edition, if there is an issue\_able in elem\_descr |
|  | \`time\_added\` | timestamp | Дата добавления | Date added |
|  | \`time\_last\_modified\` | timestamp | Дата последнего изменения | Last modified date |
|  | \`commentary\` | varchar(250) | Технический комментарий | Technical comment |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
|  | \`value\_id\` | bigint(20) | Техническое поле, хранит числовые значения поля \`value\` | Technical field, stores the numeric values ​​of the \`value\` field |
| **_\`works\_to\_editions\`_** |  |  |  |  |
|  | \`wte\_id\` | int(10) | Первичный ключ | Primary key |
|  | \`e\_id\` | int(10) | Ссылка на табл. editions | Link to table. editions |
|  | \`w\_id\` | int(10) | Ссылка на таблицу works | Works table reference |
|  | \`time\_added\` | datetime | Дата добавления | Date added |
|  | \`time\_last\_modified\` | datetime | Дата последнего изменения | Last modified date |
|  | \`uid\` | int(10) | ID пользователя, добавившего, последний раз обновившего запись, сейчас не используется | The ID of the user who added, last updated the record is not currently used |
|  | \`title\` | varchar(20) | Название Главы, раздела (если оглавление не нормализовано (нет ссылки на works)) | Title of Chapter, section (if the table of contents is not normalized (there is no reference to works)) |
|  | \`pages\` | varchar(45) | Номера страниц | Page numbers |
|  | \`level\` | int(10) | Уровень вложенности для иерархического оглавления | Nesting level for hierarchical table of contents |
|  | \`e\_num\_to\_sort\` | int(11) | Порядковый номер в оглавлении издания (для сортировки), если не указан, то сортируем по номеру страницы | Sequential number in the table of contents of the publication (for sorting), if not specified, then sort by page number |
| **_\`descr\_elems\`_** |  |  |  |  |
|  | \`id\` | int(10) | Первичный ключ | Primary key |
|  | \`lang\` | varchar(3) | Язык интерфейса (en\|ru) | Interface language (en \| ru) |
|  | \`descr\` | varchar(1000) | Полное наименование отображаемое в интерфейсе в зав. от языка | Full name displayed in the interface in the head. from the language |
|  | \`code\` | varchar(100) | Код \- как значение записано в magz\_main\_add\_descr.value | Code - as the value is written in magz\_main\_add\_descr.value |
|  | \`order\` | int(10) | Порядок сортировки элементов описания в выпадающих списках | Sort order of description items in drop-down lists |
|  | \`type\` | varchar(45) | Сылка на вид элемента описания magz\_elem\_descr.ref | Link to the description element view magz\_elem\_descr.ref |
|  | \`commentary\` | varchar(5000) | Технический комментарий | Technical comment |
|  | \`parent\_code\` | varchar(45) | Ссылка на родителя, для иерархических справочников | Link to parent, for hierarchical directories |
|  | \`parent\_value\` | varchar(45) | Значение предыдущего поля от которого зависит формирования дочернего списка | The value of the previous field on which the formation of the child list depends |
|  | \`table\_name\` | varchar(20) | (в данный момент не используется) | (currently not used) |
|  | \`table\_field\` | varchar(20) | (в данный момент не используется) | (currently not used) |
|  | \`time\_added\` | timestamp | Дата добавления | Date added |
|  | \`source\` | varchar(100) | Источник данных | Data source |
|  | \`active\` | tinyint(1) | Активный | Active |
| **_\`elem\_descr\`_** |  |  |  |  |
|  | \`key\` | int(10) | Первичный ключ | Primary key |
|  | \`commentary\` | varchar(1000) | Описание/подсказка | Description / hint |
|  | \`name\_ru\` | varchar(100) | Наименование описательного элемента на русском \- зависит от языка интерфейса | The name of the descriptive element in Russian - depends on the interface language |
|  | \`name\_en\` | varchar(100) | Наименование описательного элемента на английском | Descriptive element name in English |
|  | \`type\` | varchar(3) | тип данных \- гиперссылка, xml, ссылка на картинку и пр. | data type - hyperlink, xml, link to a picture, etc. |
|  | \`checks\` | varchar(100) | проверка значения через регулярные выражения или ссылки на справочники | checking the value through regular expressions or reference links |
|  | \`link\_pattern\` | varchar(100) | Гиперссылка для дополнения id- ссылки на справочник | Hyperlink to complement the id - links to the directory |
|  | \`name\_add1\_ru\` | varchar(100) | Наименование описательного элемента на русском | Description of the descriptive element in Russian |
|  | \`name\_add1\_en\` | varchar(100) | Наименование описательного элемента на английском | Descriptive element name in English |
|  | \`type\_add1\` | varchar(3) | тип данных \- гиперссылка, xml, ссылка на картинку и пр. | data type - hyperlink, xml, link to a picture, etc. |
|  | \`checks\_add1\` | varchar(100) | проверка значения через регулярные выражения или ссылки на справочники | checking the value through regular expressions or reference links |
|  | \`filled\_add1\` | tinyint(1) | Обязательность заполнения | Mandatory filling |
|  | \`link\_pattern\_add1\` | varchar(50) | Гиперссылка для дополнения id- ссылки на справочник | Hyperlink to complement the id - links to the directory |
|  | \`name\_add2\_ru\` | varchar(100) | Наименование описательного элемента на русском | Description of the descriptive element in Russian |
|  | \`name\_add2\_en\` | varchar(100) | Наименование описательного элемента на английском | Descriptive element name in English |
|  | \`type\_add2\` | varchar(3) | Тип данных \- гиперссылка, xml, ссылка на картинку и пр. | Data type - hyperlink, xml, link to a picture, etc. |
|  | \`checks\_add2\` | varchar(100) | проверка значения через регулярные выражения или ссылки на справочники | checking the value through regular expressions or reference links |
|  | \`filled\_add2\` | tinyint(1) | Обязательность заполнения | Mandatory filling |
|  | \`link\_pattern\_add2\` | varchar(50) | Гиперссылка для дополнения id- ссылки на справочник | Hyperlink to complement the id - links to the directory |
|  | \`name\_add3\_ru\` | varchar(100) | Наименование описательного элемента на русском | Description of the descriptive element in Russian |
|  | \`name\_add3\_en\` | varchar(100) | Наименование описательного элемента на английском | Descriptive element name in English |
|  | \`type\_add3\` | varchar(3) | Тип данных \- гиперссылка, xml, ссылка на картинку и пр. | Data type - hyperlink, xml, link to a picture, etc. |
|  | \`checks\_add3\` | varchar(100) | проверка значения через регулярные выражения или ссылки на справочники | checking the value through regular expressions or reference links |
|  | \`filled\_add3\` | tinyint(1) | Обязательность заполнения | Mandatory filling |
|  | \`link\_pattern\_add3\` | varchar(50) | Гиперссылка для дополнения id- ссылки на справочник | Hyperlink to complement the id - links to the directory |
|  | \`for\_works\` | tinyint(1) | Для произведений | For works |
|  | \`for\_publishers\` | tinyint(1) | Для издательств | For publishers |
|  | \`for\_editions\` | tinyint(1) | Для изданий | For publications |
|  | \`for\_authors\` | tinyint(1) | Для авторов | For authors |
|  | \`for\_series\` | tinyint(1) | Для серий | For episodes |
|  | \`for\_files\` | tinyint(1) | Для файлов | For files |
|  | \`dateable\` | tinyint(1) | Может ли иметь период действия с \- по | Can it have a validity period from - to |
|  | \`issueable\` | tinyint(1) | Может ли иметь период действия с выпуска \- по выпуск | May have a validity period from issue to issue |
|  | \`default\_view\_for\_edit\` | tinyint(1) | Показывать по умолчанию при редактировании | Show by default when editing |
|  | \`multiple\_values\` | tinyint(1) | У объекта может быть несколько описательных полей с одним и тем же типом | An object can have multiple descriptive fields of the same type |
|  | \`for\_libgen\` | tinyint(1) | Для раздела | For section |
|  | \`for\_fiction\` | tinyint(1) | Для раздела | For section |
|  | \`for\_fiction\_rus\` | tinyint(1) | Для раздела | For section |
|  | \`for\_scimag\` | tinyint(1) | Для раздела | For section |
|  | \`for\_magz\` | tinyint(1) | Для раздела | For section |
|  | \`for\_standarts\` | tinyint(1) | Для раздела | For section |
|  | \`for\_comics\` | tinyint(1) | Для раздела | For section |
|  | \`sort\` | int(11) | Сортировка | Sorting |
|  | \`visible\` | tinyint(1) | Видимый | Visible |
|  | \`editable\` | tinyint(1) | Возможно ручное редактирование пользователем | Manual editing by the user is possible |

\[ [Place and/or view comments (4)](https://libgen.li/community/viewtopic.php?t=31) \] \| \[ Back \]

Powered by [phpBB](https://www.phpbb.com/) ® Forum Software © phpBB Limited

[Privacy](https://libgen.li/community/ucp.php?mode=privacy&sid=6ba2324ba86fa3895ab91c69dd1d713f "Privacy")
\|
[Terms](https://libgen.li/community/ucp.php?mode=terms&sid=6ba2324ba86fa3895ab91c69dd1d713f "Terms")