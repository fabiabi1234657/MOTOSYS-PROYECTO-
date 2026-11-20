package co.motosys.notify.repository;

import co.motosys.notify.model.Event;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Repository;

@Repository
public class NotificationStore {
    @Document("notifications")
    public record Notice(@Id String id, String userId, String motorcycleId, String kind, Instant createdAt) {}

    private final MongoTemplate mongo;

    public NotificationStore(MongoTemplate mongo) {
        this.mongo = mongo;
    }

    public boolean accept(Event event) {
        return put(event.id().toString(), event.actorId(), event.motorcycleId(), event.kind().name());
    }

    public boolean put(String id, UUID userId, UUID motorcycleId, String kind) {
        try {
            return mongo.upsert(Query.query(Criteria.where("_id").is(id)), new Update()
                .setOnInsert("userId", userId.toString())
                .setOnInsert("motorcycleId", motorcycleId.toString())
                .setOnInsert("kind", kind)
                .setOnInsert("createdAt", Instant.now()), Notice.class).getUpsertedId() != null;
        } catch (org.springframework.dao.DuplicateKeyException exception) {
            return false;
        }
    }

    public List<Notice> forUser(UUID user) {
        return mongo.find(Query.query(Criteria.where("userId").is(user.toString()))
                .with(Sort.by(Sort.Direction.DESC, "createdAt")).limit(100), Notice.class);
    }
}
