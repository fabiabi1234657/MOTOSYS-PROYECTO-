package co.motosys.notify.controller;

import co.motosys.notify.repository.NotificationStore;
import co.motosys.notify.service.AccessService;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.concurrent.Executor;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.context.request.async.DeferredResult;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/reports")
public class ReportController {
    private final Executor executor;
    private final AccessService access;
    private final NotificationStore notifications;
    private final JdbcTemplate postgres;
    enum Format { csv, pdf }

    public ReportController(@Qualifier("reportExecutor") Executor executor, AccessService access, NotificationStore notifications, JdbcTemplate postgres) {
        this.executor = executor;
        this.access = access;
        this.notifications = notifications;
        this.postgres = postgres;
    }

    @GetMapping("/notifications/{format}")
    public DeferredResult<ResponseEntity<byte[]>> report(
            @RequestHeader(value="Authorization", required=false) String auth, @PathVariable Format format) {
        var user = access.authenticate(auth);
        return render(format, "notifications", () -> notifications.forUser(user.id()).stream()
                .filter(row -> access.canRead(user, UUID.fromString(row.motorcycleId()))).toList());
    }

    @GetMapping("/motorcycles/{motorcycleId}/{format}")
    public DeferredResult<ResponseEntity<byte[]>> motorcycleReport(
            @RequestHeader(value="Authorization", required=false) String auth,
            @PathVariable UUID motorcycleId, @PathVariable Format format) {
        var user = access.authenticate(auth);
        access.requireMotorcycle(user, motorcycleId);
        return render(format, "motorcycle-history", () -> postgres.query(
                "SELECT id,kind,occurred_at FROM vehicle_events WHERE motorcycle_id=? ORDER BY occurred_at DESC LIMIT 100",
                (rs, index) -> new NotificationStore.Notice(rs.getString("id"), user.id().toString(),
                        motorcycleId.toString(), rs.getString("kind"), rs.getTimestamp("occurred_at").toInstant()),
                motorcycleId));
    }

    private DeferredResult<ResponseEntity<byte[]>> render(Format format, String filename,
                                                           Supplier<List<NotificationStore.Notice>> source) {
        var response = new DeferredResult<ResponseEntity<byte[]>>(10000L);
        response.onTimeout(() -> response.setErrorResult(new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE)));
        try {
            executor.execute(() -> {
                if (response.isSetOrExpired()) return;
                try {
                    var rows = source.get();
                    var bytes = format == Format.csv ? csv(rows) : pdf(rows);
                    response.setResult(ResponseEntity.ok()
                            .contentType(MediaType.parseMediaType(format == Format.csv ? "text/csv;charset=utf-8" : "application/pdf"))
                            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "." + format + "\"")
                            .body(bytes));
                } catch (IOException | RuntimeException exception) {
                    response.setErrorResult(new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR));
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException exception) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "La cola de reportes está llena.");
        }
        return response;
    }

    static byte[] csv(List<NotificationStore.Notice> rows) {
        StringBuilder text = new StringBuilder("id,tipo,motocicleta,fecha\r\n");
        rows.forEach(row -> text.append(row.id()).append(',').append(row.kind()).append(',')
                .append(row.motorcycleId()).append(',').append(row.createdAt()).append("\r\n"));
        return text.toString().getBytes(StandardCharsets.UTF_8);
    }

    static byte[] pdf(List<NotificationStore.Notice> rows) throws IOException {
        try (var pdf = new PDDocument(); var output = new ByteArrayOutputStream()) {
            int count = Math.max(1, (rows.size() + 39) / 40);
            for (int pageIndex = 0; pageIndex < count; pageIndex++) {
                var page = new PDPage();
                pdf.addPage(page);
                try (var stream = new PDPageContentStream(pdf, page)) {
                    stream.beginText();
                    stream.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 10);
                    stream.setLeading(16);
                    stream.newLineAtOffset(48, 740);
                    stream.showText("MotoSys - Historial");
                    stream.newLine();
                    for (var row : rows.subList(pageIndex * 40, Math.min(rows.size(), (pageIndex + 1) * 40))) {
                        stream.showText(row.createdAt().toString() + "  " + row.kind() + "  " + row.motorcycleId());
                        stream.newLine();
                    }
                    stream.endText();
                }
            }
            pdf.save(output);
            return output.toByteArray();
        }
    }
}
