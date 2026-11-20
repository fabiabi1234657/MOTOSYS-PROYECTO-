package co.motosys.notify.service;

import co.motosys.notify.NotifyApplication;
import co.motosys.notify.model.Event;
import co.motosys.notify.repository.NotificationStore;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.Validator;
import org.springframework.amqp.AmqpRejectAndDontRequeueException;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Service;

@Service
public class EventConsumer {
    private final ObjectMapper mapper;
    private final Validator validator;
    private final NotificationStore notifications;

    public EventConsumer(ObjectMapper mapper, Validator validator, NotificationStore notifications) {
        this.mapper = mapper;
        this.validator = validator;
        this.notifications = notifications;
    }

    @RabbitListener(queues = NotifyApplication.EVENTS_QUEUE)
    public void consume(Message message) {
        try {
            Event event = mapper.readValue(new String(message.getBody(), java.nio.charset.StandardCharsets.UTF_8), Event.class);
            if (event == null || !validator.validate(event).isEmpty()) {
                throw new AmqpRejectAndDontRequeueException("Evento inválido");
            }
            notifications.accept(event);
        } catch (JsonProcessingException exception) {
            throw new AmqpRejectAndDontRequeueException("Evento JSON inválido");
        }
    }
}
