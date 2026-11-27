# Surgical OOXML Editing

Use the absolute runtime and helper paths returned by `load_workspace_dependencies`.

```sh
"PYTHON" "HELPER" unpack input.docx unpacked
"PYTHON" "HELPER" redline unpacked 'Old wording' 'New wording'
"PYTHON" "HELPER" comment unpacked 'Please confirm.' --anchor 'Separate unchanged text'
"PYTHON" "HELPER" comment unpacked 'Confirmed.' --reply-to COMMENT_ID
"PYTHON" "HELPER" validate unpacked --original input.docx
"PYTHON" "HELPER" pack unpacked output.docx --validate --original input.docx
```

A repeated anchor requires a zero-based `--occurrence`. Replacements and comment anchors must fit in one paragraph across ordinary text runs. Matches through fields, tabs, drawings, or existing revision wrappers are rejected. An empty replacement proposes deletion. Use the same `--author` for editing and baseline validation; `--initials` controls comment initials.

For scripted operations, import `DocxPackage` from `ooxml_engine` with the skill's `scripts` directory on `PYTHONPATH`. Use `find_paragraphs`, `find_runs`, or `find_tables` with a substring, `regex=`, `index=`, or `xpath=` (`w` prefix); `part=` selects an XML part. `insert_paragraph_tracked(text, before=...)` and `after=...` take a zero-based paragraph index or a paragraph element. `delete_paragraph_tracked` takes either form. Call `save()` before validation. `accept_revisions` and `reject_revisions` optionally filter by `author` or `ids`; resolve related paragraph-mark and run revisions together. Produce an accepted copy separately from the review document.

Baseline validation checks normalized paragraph text after undoing this author's new insertions and deletions; it does not certify styles, pagination, or non-text changes. Render the packed file to review those effects.
