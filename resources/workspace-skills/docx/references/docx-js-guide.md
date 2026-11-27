# Create Documents with JavaScript

Use the returned `nodePath` with the managed `docx@9.16.0` library. Use CommonJS `require("docx")` and write the result of `Packer.toBuffer` to the requested path. Page sizes in DXA (twentieths of a point): US Letter `12240 × 15840`; A4 `11906 × 16838`.

```js
const fs = require("node:fs/promises");
const d = require("docx");
const width = { size: 9360, type: d.WidthType.DXA };
const document = new d.Document({
  styles: { paragraphStyles: [{ id: "Heading1", name: "Heading 1",
    basedOn: "Normal", paragraph: { outlineLevel: 0 } }] },
  numbering: { config: [
    { reference: "bullet", levels: [{ level: 0, format: d.LevelFormat.BULLET, text: "•" }] },
    { reference: "decimal", levels: [{ level: 0, format: d.LevelFormat.DECIMAL, text: "%1." }] },
  ] },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 },
      margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
    headers: { default: new d.Header({ children: [new d.Paragraph("Report")] }) },
    footers: { default: new d.Footer({ children: [new d.Paragraph({
      children: [new d.TextRun({ children: ["Page ", d.PageNumber.CURRENT] })] })] }) },
    children: [
      new d.TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-3" }),
      new d.Paragraph({ text: "Summary", heading: d.HeadingLevel.HEADING_1 }),
      new d.Paragraph({ text: "First item", numbering: { reference: "decimal", level: 0 } }),
      new d.Table({ width, columnWidths: [4680, 4680], rows: [new d.TableRow({
        children: ["Item", "Value"].map(text => new d.TableCell({
          width: { size: 4680, type: d.WidthType.DXA },
          shading: { type: d.ShadingType.CLEAR, fill: "EAF0F5" },
          children: [new d.Paragraph(text)],
        })),
      })] }),
      new d.Paragraph({ children: [new d.PageBreak()] }),
    ],
  }],
});
async function main() {
  await fs.writeFile(process.argv[2], await d.Packer.toBuffer(document));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
```

Set table width and column widths as well as the corresponding cell widths; their sums should equal the available body width. Use `ImageRun({ type: "png", data, transformation: { width, height } })` in a paragraph, with image bytes and pixel dimensions that preserve the aspect ratio. Update the table of contents field in a document editor before final review. Validate the archive, then render and inspect the output.
