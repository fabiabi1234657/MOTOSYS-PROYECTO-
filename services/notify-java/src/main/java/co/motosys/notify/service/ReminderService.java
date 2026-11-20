package co.motosys.notify.service;

import co.motosys.notify.repository.NotificationStore;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.query.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class ReminderService {
    @Document("reminders")
    public record Reminder(@Id String id, String userId, String motorcycleId,
                            Instant dueAt, Integer kilometers, String status) {}
    private final MongoTemplate mongo;
    private final JdbcTemplate postgres;
    private final NotificationStore notices;

    public ReminderService(MongoTemplate mongo, JdbcTemplate postgres, NotificationStore notices) {
        this.mongo = mongo;
        this.postgres = postgres;
        this.notices = notices;
    }

    public Reminder create(UUID user, UUID motorcycle, Instant due, Integer kilometers) {
        return mongo.insert(new Reminder(UUID.randomUUID().toString(), user.toString(),
                motorcycle.toString(), due, kilometers, "PENDING"));
    }

    public List<Reminder> list(UUID user) {
        return mongo.find(Query.query(Criteria.where("userId").is(user.toString())).limit(100), Reminder.class);
    }

    @Scheduled(fixedDelayString = "${motosys.reminder-delay-ms:30000}")
    public void resolveDue() {
        dueByDate();
        dueByMileage();
    }

    private void dueByDate() {
        Query query = Query.query(Criteria.where("status").is("PENDING").and("dueAt").lte(Instant.now())).limit(50);
        mongo.find(query, Reminder.class).forEach(this::dispatch);
    }

    private void dueByMileage() {
        try (var pending = mongo.stream(Query.query(Criteria.where("status").is("PENDING").and("kilometers").ne(null)), Reminder.class)) {
            pending
                .forEach(reminder -> {
                    List<Integer> current = postgres.queryForList("SELECT odometer_km FROM motorcycles WHERE id=?",
                            Integer.class, UUID.fromString(reminder.motorcycleId()));
                    if (!current.isEmpty() && current.getFirst() >= reminder.kilometers()) dispatch(reminder);
                });
        }
    }

    private void dispatch(Reminder reminder) {
        notices.put("reminder:" + reminder.id(), UUID.fromString(reminder.userId()),
                UUID.fromString(reminder.motorcycleId()), "REMINDER");
        mongo.updateFirst(Query.query(Criteria.where("_id").is(reminder.id()).and("status").is("PENDING")),
                Update.update("status", "SENT"), Reminder.class);
    }
}
