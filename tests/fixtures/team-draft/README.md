# Draft document extraction fixtures

These small, non-sensitive test documents come from Apache Tika's Microsoft parser tests and are covered by the accompanying Apache License 2.0 file. They are test-only and are not included in the desktop application package.

- `sample.doc`: https://github.com/apache/tika/blob/main/tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-microsoft-module/src/test/resources/test-documents/testWORD.doc
- `sample.ppt`: https://github.com/apache/tika/blob/main/tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-microsoft-module/src/test/resources/test-documents/testPPT.ppt
- `sample.xls`: https://github.com/apache/tika/blob/main/tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-microsoft-module/src/test/resources/test-documents/testEXCEL.xls

The corresponding `sample.docx`, `sample.pptx`, and `sample.xlsx` fixtures are the same upstream paths with the modern extensions (`testWORD.docx`, `testPPT.pptx`, and `testEXCEL.xlsx`).

The tests parse their actual OLE/OOXML binary content offline and assert the extracted document text. They do not execute macros, render HTML, or reinterpret binary bytes as UTF-8 text.
