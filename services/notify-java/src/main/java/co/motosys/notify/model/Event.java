package co.motosys.notify.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public record Event(@NotNull UUID id, @NotNull Kind kind,
                    @NotNull @JsonProperty("motorcycle_id") UUID motorcycleId,
                    @NotNull @JsonProperty("actor_id") UUID actorId) {
    public enum Kind { MAINTENANCE, EXPENSE }
}
