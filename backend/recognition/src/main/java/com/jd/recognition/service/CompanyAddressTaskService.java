package com.jd.recognition.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.IOException;
import java.time.Instant;
import java.nio.file.StandardCopyOption;
import java.util.UUID;

public class CompanyAddressTaskService extends FileTaskQueueService {
    public CompanyAddressTaskService(ObjectMapper mapper, String projectRoot, String directory, boolean enabled,
            String node, String codex, String model, String effort, int timeout, String apiBase) {
        super(mapper, projectRoot, directory, "runtime/company-addresses", "ops/jd-import/address-worker.mjs", "company-address:",
                enabled, node, codex, model, effort, timeout, apiBase);
    }

    public JsonNode create(Long companyId, String companyName) {
        var seed = mapper.createObjectNode();
        seed.put("companyId", companyId);
        seed.put("companyName", companyName);
        return enqueue(seed, "companyId");
    }

    @Override
    protected String taskGroupKey() { return "companyId"; }

    @Override
    protected boolean canLaunch(JsonNode state) throws IOException {
        var batch = readBatch();
        if (batch == null) return true; // Existing queues remain compatible until batch control is first used.
        if (!"RUNNING".equals(batch.path("status").asText())) return false;
        for (var entry : batch.path("entries")) {
            if ("QUEUED".equals(detail(entry.path("taskId").asText()).path("status").asText()))
                return entry.path("taskId").equals(state.path("taskId"));
        }
        return false;
    }

    public synchronized ObjectNode readBatch() throws IOException {
        Path file = root.resolve("batch.json");
        return Files.isRegularFile(file) ? (ObjectNode) mapper.readTree(Files.readAllBytes(file)) : null;
    }

    public synchronized void writeBatch(ObjectNode batch) throws IOException {
        Files.createDirectories(root);
        batch.put("updatedAt", Instant.now().toString());
        Path temporary = root.resolve(UUID.randomUUID() + ".tmp");
        Files.write(temporary, mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(batch));
        Files.move(temporary, root.resolve("batch.json"), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    public synchronized void requestStop(JsonNode task) throws IOException {
        Path run = root.resolve("jobs").resolve(task.path("taskId").asText()).resolve("attempt-" + task.path("attempt").asInt());
        Files.createDirectories(run);
        Files.writeString(run.resolve("stop.requested"), Instant.now().toString());
    }
}
