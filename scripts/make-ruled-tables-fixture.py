"""Regenerates src/tests/fixtures/ruled-tables.pdf (needs `pip install reportlab`).

The tables are drawn with ruling lines and tightly spaced columns, the layout the
engine's text-based recogniser flattens into a paragraph (it returned 0 tables).

    python scripts/make-ruled-tables-fixture.py
"""
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ss = getSampleStyleSheet()
grid = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
inv = [["Item", "Qty", "Price"]] + [[f"Item {i}", str(i), f"{i * 1.5:.2f}"] for i in range(1, 8)]
span = [["Region", "", "Total"], ["North", "A", "10"], ["South", "B", "20"], ["East", "C", "30"]]
outline = [["Name", "Score"], ["Ada", "98"], ["Bo", "87"], ["Cy", "76"], ["Di", "65"]]

story = [
    Paragraph("Quarterly report", ss["Title"]),
    Paragraph("Inventory and regional totals.", ss["Normal"]),
    Spacer(1, 12),
    Table(inv, style=TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black), ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey)])),
    Spacer(1, 24),
    Table(span, style=TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black), ("SPAN", (0, 0), (1, 0))])),
    PageBreak(),
    Paragraph("Page two", ss["Heading2"]),
    Table([["", "", ""]] * 3, colWidths=[80] * 3, rowHeights=[28] * 3, style=grid),
    Spacer(1, 24),
    Table(outline, style=TableStyle([("BOX", (0, 0), (-1, -1), 1, colors.black), ("LINEBELOW", (0, 0), (-1, 0), 1, colors.black), ("LINEAFTER", (0, 0), (0, -1), 0.5, colors.grey)])),
]
SimpleDocTemplate("src/tests/fixtures/ruled-tables.pdf", pagesize=A4, invariant=1, pageCompression=1).build(story)
