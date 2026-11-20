package co.motosys.notify.controller;

import co.motosys.notify.model.Event;
import co.motosys.notify.repository.NotificationStore;
import co.motosys.notify.service.AccessService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import jakarta.validation.Valid;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class NotificationController {
    private final AccessService access;
    private final NotificationStore notifications;
    private final byte[] credential;

    public NotificationController(AccessService access, NotificationStore notifications,
                                  @Value("${motosys.service-token}") String token) {
        if (token.length() < 32) throw new IllegalArgumentException("NOTIFICATIONS_TOKEN requiere al menos 32 caracteres");
        this.access = access;
        this.notifications = notifications;
        this.credential = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
    }

    @PostMapping("/internal/notifications/events")
    @Operation(security = @SecurityRequirement(name = "serviceToken"), responses = {
        @ApiResponse(responseCode = "201", description = "Evento registrado"),
        @ApiResponse(responseCode = "200", description = "Evento ya registrado"),
        @ApiResponse(responseCode = "401", description = "Credencial interna inválida"),
        @ApiResponse(responseCode = "409", description = "Idempotency-Key no coincide con el evento")
    })
    public ResponseEntity<Void> ingest(@RequestHeader(value = "Authorization", required = false) String authorization,
                                      @RequestHeader("Idempotency-Key") String key,
                                      @Valid @RequestBody Event event) {
        if (authorization == null || !MessageDigest.isEqual(credential, authorization.getBytes(StandardCharsets.UTF_8))) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        }
        if (!event.id().toString().equals(key)) throw new ResponseStatusException(HttpStatus.CONFLICT);
        return ResponseEntity.status(notifications.accept(event) ? HttpStatus.CREATED : HttpStatus.OK).build();
    }

    @GetMapping("/notifications")
    public List<NotificationStore.Notice> list(@RequestHeader(value = "Authorization", required = false) String authorization) {
        var account = access.authenticate(authorization);
        return notifications.forUser(account.id()).stream()
                .filter(row -> access.canRead(account, java.util.UUID.fromString(row.motorcycleId()))).toList();
    }
}
