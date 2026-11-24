package co.motosys.notify;

import io.swagger.v3.oas.annotations.OpenAPIDefinition;
import io.swagger.v3.oas.annotations.enums.SecuritySchemeType;
import io.swagger.v3.oas.annotations.enums.SecuritySchemeIn;
import io.swagger.v3.oas.annotations.info.Info;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.security.SecurityScheme;
import java.util.concurrent.ThreadPoolExecutor;
import org.springframework.amqp.core.Queue;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

@SpringBootApplication
@EnableScheduling
@OpenAPIDefinition(info = @Info(title = "MotoSys Notify", version = "1.0.0"),
        security = {@SecurityRequirement(name = "session"), @SecurityRequirement(name = "webSession")})
@SecurityScheme(name = "session", type = SecuritySchemeType.HTTP, scheme = "bearer",
        description = "Sesión opaca de MotoSys")
@SecurityScheme(name = "webSession", type = SecuritySchemeType.APIKEY, in = SecuritySchemeIn.COOKIE,
        paramName = "__Host-motosys", description = "Sesión Web. Envía X-CSRF-Token para mutaciones.")
@SecurityScheme(name = "serviceToken", type = SecuritySchemeType.HTTP, scheme = "bearer",
        description = "Credencial interna de entrega")
public class NotifyApplication {
    public static final String EVENTS_QUEUE = "motosys.notifications";

    public static void main(String[] args) {
        SpringApplication.run(NotifyApplication.class, args);
    }

    @Bean
    Queue eventsQueue() {
        return new Queue(EVENTS_QUEUE, true);
    }

    @Bean(name = "reportExecutor")
    ThreadPoolTaskExecutor reportExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(8);
        executor.setQueueCapacity(50);
        executor.setAwaitTerminationSeconds(5);
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        executor.setThreadNamePrefix("motosys-report-");
        return executor;
    }
}
