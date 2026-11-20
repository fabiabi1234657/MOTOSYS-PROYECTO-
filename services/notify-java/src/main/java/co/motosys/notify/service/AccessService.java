package co.motosys.notify.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class AccessService {
    private final StringRedisTemplate redis;
    private final JdbcTemplate postgres;
    private final ObjectMapper json;

    record Session(UUID userId, long expiresAt, boolean mfa, long version) {}
    public record Account(UUID id, String role, UUID workshopId, long sessionVersion) {}
    record Scope(UUID ownerId, UUID workshopId, int kilometers) {}

    public AccessService(StringRedisTemplate redis, JdbcTemplate postgres, ObjectMapper json) {
        this.redis = redis;
        this.postgres = postgres;
        this.json = json;
    }

    public Account authenticate(String authorization) {
        if (authorization == null || !authorization.matches("Bearer [A-Za-z0-9_-]{43}")) {
            throw unauthorized();
        }
        String key = "session:" + hash(authorization.substring(7).getBytes(StandardCharsets.US_ASCII));
        String stored = redis.opsForValue().get(key);
        if (stored == null) throw unauthorized();
        try {
            Session session = json.readValue(stored, Session.class);
            long remaining = session.expiresAt() - System.currentTimeMillis();
            if (remaining <= 0) throw unauthorized();
            Account account = postgres.queryForObject(
                    "SELECT id, role, workshop_id, session_version FROM users WHERE id=?",
                    (rs, index) -> new Account(rs.getObject("id", UUID.class), rs.getString("role"),
                            rs.getObject("workshop_id", UUID.class), rs.getLong("session_version")),
                    session.userId());
            if (account == null || session.version() != account.sessionVersion()
                    || (!account.role().equals("RIDER") && !session.mfa())
                    || !Boolean.TRUE.equals(redis.expire(key, Duration.ofMillis(Math.min(remaining, 1800000))))) {
                throw unauthorized();
            }
            return account;
        } catch (JsonProcessingException | EmptyResultDataAccessException exception) {
            throw unauthorized();
        }
    }

    public int requireMotorcycle(Account account, UUID motorcycle) {
        try {
            Scope scope = postgres.queryForObject("SELECT owner_id, workshop_id, odometer_km FROM motorcycles WHERE id=?",
                    (rs, index) -> new Scope(rs.getObject("owner_id", UUID.class),
                            rs.getObject("workshop_id", UUID.class), rs.getInt("odometer_km")), motorcycle);
            if (scope == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
            boolean allowed = switch (account.role()) {
                case "SUPER_ADMIN" -> true;
                case "WORKSHOP_ADMIN" -> account.workshopId() != null && account.workshopId().equals(scope.workshopId());
                case "RIDER" -> account.id().equals(scope.ownerId());
                default -> false;
            };
            if (!allowed) throw new ResponseStatusException(HttpStatus.FORBIDDEN);
            return scope.kilometers();
        } catch (EmptyResultDataAccessException exception) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
    }

    public boolean canRead(Account account, UUID motorcycle) {
        try {
            requireMotorcycle(account, motorcycle);
            return true;
        } catch (ResponseStatusException exception) {
            int status = exception.getStatusCode().value();
            if (status == 403 || status == 404) return false;
            throw exception;
        }
    }

    static ResponseStatusException unauthorized() {
        return new ResponseStatusException(HttpStatus.UNAUTHORIZED);
    }

    public static String hash(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        }
    }
}
