package co.motosys.notify.controller;

import co.motosys.notify.service.AccessService;
import co.motosys.notify.service.ReminderService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/reminders")
public class ReminderController {
    record Request(@NotNull UUID motorcycleId, Instant dueAt, @PositiveOrZero Integer kilometers) {}
    private final AccessService access;
    private final ReminderService reminders;

    public ReminderController(AccessService access, ReminderService reminders) {
        this.access = access;
        this.reminders = reminders;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ReminderService.Reminder create(@RequestHeader(value="Authorization", required=false) String auth,
                                           @Valid @RequestBody Request request) {
        var account = access.authenticate(auth);
        access.requireMotorcycle(account, request.motorcycleId());
        if (request.dueAt() == null && request.kilometers() == null) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        return reminders.create(account.id(), request.motorcycleId(), request.dueAt(), request.kilometers());
    }

    @GetMapping
    public List<ReminderService.Reminder> list(@RequestHeader(value="Authorization", required=false) String auth) {
        var account = access.authenticate(auth);
        return reminders.list(account.id()).stream().filter(row -> {
            try {
                access.requireMotorcycle(account, UUID.fromString(row.motorcycleId()));
                return true;
            } catch (ResponseStatusException exception) {
                if (exception.getStatusCode().value() == 403 || exception.getStatusCode().value() == 404) return false;
                throw exception;
            }
        }).toList();
    }
}
