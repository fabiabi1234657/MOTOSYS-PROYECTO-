package co.motosys.notify.controller;

import co.motosys.notify.service.AccessService;
import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/documents")
public class DocumentController {
    @Document("vehicle_documents")
    @CompoundIndex(name = "motorcycleId_1_fileHash_1", def = "{'motorcycleId':1,'fileHash':1}", unique = true)
    record VehicleDocument(@Id String id, String motorcycleId, String fileHash, int size, Instant createdAt, byte[] content) {}
    record Metadata(String id, String fileHash, int size, Instant createdAt) {}

    private final AccessService access;
    private final MongoTemplate mongo;

    public DocumentController(AccessService access, MongoTemplate mongo) {
        this.access = access;
        this.mongo = mongo;
    }

    @PostMapping(path = "/{motorcycleId}", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @ResponseStatus(HttpStatus.CREATED)
    public Metadata upload(@RequestHeader(value="Authorization", required=false) String auth,
                           @PathVariable UUID motorcycleId, @RequestParam MultipartFile file) throws IOException {
        access.requireMotorcycle(access.authenticate(auth), motorcycleId);
        if (file.isEmpty() || file.getSize() > 2097152) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        byte[] bytes = file.getBytes();
        VehicleDocument document = new VehicleDocument(UUID.randomUUID().toString(), motorcycleId.toString(),
                AccessService.hash(bytes), bytes.length, Instant.now(), bytes);
        try {
            return metadata(mongo.insert(document));
        } catch (DuplicateKeyException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "El documento ya existe para la motocicleta.");
        }
    }

    @GetMapping("/{motorcycleId}")
    public List<Metadata> list(@RequestHeader(value="Authorization", required=false) String auth, @PathVariable UUID motorcycleId) {
        access.requireMotorcycle(access.authenticate(auth), motorcycleId);
        Query query = Query.query(Criteria.where("motorcycleId").is(motorcycleId.toString())).limit(100);
        query.fields().exclude("content");
        return mongo.find(query, VehicleDocument.class).stream().map(DocumentController::metadata).toList();
    }

    @GetMapping("/{motorcycleId}/{documentId}")
    public ResponseEntity<byte[]> download(@RequestHeader(value="Authorization", required=false) String auth,
                                           @PathVariable UUID motorcycleId, @PathVariable UUID documentId) {
        access.requireMotorcycle(access.authenticate(auth), motorcycleId);
        VehicleDocument row = mongo.findOne(Query.query(Criteria.where("motorcycleId").is(motorcycleId.toString())
                .and("_id").is(documentId.toString())), VehicleDocument.class);
        if (row == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"document.bin\"")
                .header("X-Content-Type-Options", "nosniff").body(row.content());
    }

    private static Metadata metadata(VehicleDocument doc) {
        return new Metadata(doc.id(), doc.fileHash(), doc.size(), doc.createdAt());
    }
}
