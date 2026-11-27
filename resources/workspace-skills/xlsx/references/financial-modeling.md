# Financial Modeling

- Keep assumptions in a dedicated section or tab. Reference them from formulas rather than embedding adjustable constants.
- Use font colors `0000FF` for inputs, `000000` for same-sheet formulas, `008000` for cross-sheet links, and `FF0000` for external links. Use `FFF2CC` or `FFFF00` fill for key assumptions.
- Format currency as `$#,##0;($#,##0);"-"`, percentages as `0.0%`, multiples as `0.0"x"`, and year headers as text such as `"2026"`.
- Size columns to fit the longest formatted value plus at least two characters. Include space for negative signs, parentheses, and currency symbols; check that no cells display `###`. For wrapped labels, allocate row height for every line plus a small buffer, and verify the rendered result.
- Use formulas for totals and align repeated projection formulas horizontally. Run `recalc --strict` and `audit` after edits; review warnings and optionally `render` for layout.
