package co.motosys.notify.controller;

import static org.junit.jupiter.api.Assertions.*;

import co.motosys.notify.repository.NotificationStore.Notice;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;

class ReportControllerTest {
    @Test
    void rendersCsvAndReadablePdf() throws IOException {
        var rows = List.of(new Notice("1", "user", "moto", "MAINTENANCE", Instant.EPOCH));
        var csv = new String(ReportController.csv(rows), StandardCharsets.UTF_8);
        assertTrue(csv.contains("1,MAINTENANCE,moto,1970-01-01T00:00:00Z"));
        try (var pdf = Loader.loadPDF(ReportController.pdf(rows))) {
            assertEquals(1, pdf.getNumberOfPages());
            assertTrue(new PDFTextStripper().getText(pdf).contains("MAINTENANCE"));
        }
    }
}
