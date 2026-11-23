"""Exporta el informe Markdown a Word y PDF con python-docx y ReportLab."""
from html import escape
from pathlib import Path
import re

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from PIL import Image as RasterImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Image, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

DOCS = Path(__file__).resolve().parents[1]
SOURCE = DOCS / "informe-proyecto.md"
WORD = SOURCE.with_suffix(".docx")
PDF = SOURCE.with_suffix(".pdf")


def tokenize(text):
    lines = iter(text.splitlines())
    pending = None
    while True:
        line = pending if pending is not None else next(lines, None)
        pending = None
        if line is None:
            return
        if not line.strip():
            continue
        if line.startswith("|"):
            items = []
            while line and line.startswith("|"):
                row = [cell.strip() for cell in line.strip("|").split("|")]
                if not all(re.fullmatch(r"[-: ]+", cell) for cell in row):
                    items.append(row)
                line = next(lines, None)
            pending = line
            yield "table", items
        elif line.startswith("### "):
            yield "subheading", line[4:]
        elif line.startswith("## "):
            yield "heading", line[3:]
        elif line.startswith("# "):
            yield "title", line[2:]
        elif line.startswith("- "):
            yield "bullet", line[2:]
        else:
            yield "body", line


def chunks(value):
    for piece in re.split(r"(`[^`]+`|\*[^*]+\*)", value):
        if not piece:
            continue
        if piece.startswith("`") and piece.endswith("`"):
            yield piece[1:-1], False
        elif piece.startswith("*") and piece.endswith("*"):
            yield piece[1:-1], True
        else:
            yield piece, False


def put(paragraph, value):
    for text, italic in chunks(value):
        paragraph.add_run(text).italic = italic


def markup(value):
    return "".join(f"<i>{escape(text)}</i>" if italic else escape(text) for text, italic in chunks(value))


styles = {
    "title": ParagraphStyle("Title", fontName="Times-Bold", fontSize=25, leading=29, spaceAfter=16),
    "heading": ParagraphStyle("Heading", fontName="Times-Bold", fontSize=15, leading=19, spaceBefore=11, spaceAfter=5, keepWithNext=True),
    "subheading": ParagraphStyle("Subheading", fontName="Times-Bold", fontSize=13, leading=16, spaceBefore=9, spaceAfter=5, keepWithNext=True),
    "body": ParagraphStyle("Body", fontName="Times-Roman", fontSize=11, leading=15, spaceAfter=7, alignment=TA_LEFT),
    "reference": ParagraphStyle("Reference", fontName="Times-Roman", fontSize=11, leading=15, spaceAfter=10, leftIndent=36, firstLineIndent=-36),
    "bullet": ParagraphStyle("Bullet", fontName="Times-Roman", fontSize=11, leading=15, spaceAfter=4, leftIndent=13, bulletIndent=1),
    "cell": ParagraphStyle("Cell", fontName="Times-Roman", fontSize=9, leading=11),
    "cell_heading": ParagraphStyle("CellHeading", fontName="Times-Bold", fontSize=9, leading=11),
}


def export():
    document = Document()
    document.core_properties.title = "Informe final de MotoSys"
    document.core_properties.subject = "Proyecto final de Programación Avanzada 2026-2"
    section = document.sections[0]
    section.top_margin = section.bottom_margin = Inches(0.85)
    section.left_margin = section.right_margin = Inches(0.9)
    normal = document.styles["Normal"]
    normal.font.name = "Times New Roman"
    normal.font.size = Pt(11)
    normal.paragraph_format.line_spacing = 1.28
    for name in ("Title", "Heading 1", "Heading 2"):
        style = document.styles[name]
        style.font.name = "Times New Roman"
        style.font.color.rgb = RGBColor.from_string("000000")
        if name == "Title":
            properties = style.element.get_or_add_pPr()
            for border in properties.findall(qn("w:pBdr")):
                properties.remove(border)
            border = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            bottom.set(qn("w:val"), "nil")
            border.append(bottom)
            properties.append(border)
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    footer._p.append(field)
    blocks = []
    references = False

    for kind, content in tokenize(SOURCE.read_text(encoding="utf-8")):
        if kind == "subheading" and content == "Referencias":
            references = True
            blocks.append(PageBreak())
        if kind == "table":
            rows = content
            table = document.add_table(rows=0, cols=len(rows[0]))
            table.style = "Light Shading Accent 1"
            cells = []
            for index, row in enumerate(rows):
                current = table.add_row()
                if not index:
                    current._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
                current._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))
                for cell, item in zip(current.cells, row):
                    paragraph = cell.paragraphs[0]
                    if len(rows) <= 5 and index < len(rows)-1:
                        paragraph.paragraph_format.keep_with_next = True
                    fragment = paragraph.add_run(item.replace("`", ""))
                    fragment.font.size = Pt(9)
                    fragment.bold = index == 0
                cells.append([Paragraph(markup(item), styles["cell_heading" if not index else "cell"]) for item in row])
            widths = [78, 74, 92, 107, 121] if len(rows[0]) == 5 else [122, 142, 208]
            layout = Table(cells, colWidths=widths, repeatRows=1, hAlign="LEFT")
            layout.setStyle(TableStyle([
                ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#E3EAF2")),
                ("VALIGN", (0,0), (-1,-1), "TOP"),
                ("LINEBELOW", (0,0), (-1,0), 0.7, colors.HexColor("#94A3B8")),
                ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#F4F7FA")]),
                ("BOTTOMPADDING", (0,0), (-1,-1), 5), ("TOPPADDING", (0,0), (-1,-1), 5),
            ]))
            blocks.extend([layout, Spacer(1,8)])
            continue
        word_style = {"title":"Title","heading":"Heading 1","subheading":"Heading 2","bullet":"List Bullet"}.get(kind, "Normal")
        paragraph = document.add_paragraph(style=word_style)
        if references and kind == "body":
            paragraph.paragraph_format.left_indent = Inches(.5)
            paragraph.paragraph_format.first_line_indent = Inches(-.5)
            kind = "reference"
        if kind == "subheading" and content == "Referencias":
            paragraph.paragraph_format.page_break_before = True
        put(paragraph, content)
        block = Paragraph(markup(content), styles[kind], bulletText="•" if kind=="bullet" else None)
        source = re.search(r"Archivo: docs/(diagrams/[a-z4-]+\.mmd|evidence/[a-z-]+\.png)\.", content) if kind == "body" else None
        image = DOCS / Path(source.group(1)).with_suffix(".png") if source else None
        if image and image.is_file():
            with RasterImage.open(image) as bitmap:
                width, height = bitmap.size
            scale = min(468 / width, 228 / height)
            paragraph.paragraph_format.keep_with_next = True
            holder = document.add_paragraph()
            holder.alignment = WD_ALIGN_PARAGRAPH.CENTER
            holder.add_run().add_picture(str(image), width=Pt(width*scale))
            figure = Image(str(image), width=width*scale, height=height*scale)
            blocks.append(KeepTogether([block, figure, Spacer(1, 8)]))
        else:
            blocks.append(block)

    document.save(WORD)
    pdf = SimpleDocTemplate(str(PDF), title="Informe final de MotoSys", pagesize=letter,
                            leftMargin=64, rightMargin=64, topMargin=58, bottomMargin=57)

    def page_number(canvas, doc):
        canvas.setFont("Times-Roman", 10)
        canvas.setFillColor(colors.HexColor("#334155"))
        canvas.drawRightString(letter[0]-64, 32, str(doc.page))

    pdf.build(blocks, onFirstPage=page_number, onLaterPages=page_number)


if __name__ == "__main__":
    export()
