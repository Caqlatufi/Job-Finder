package com.jd.recognition.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CompanyAddressTaskServiceTest {
    @TempDir Path root;
    private final ObjectMapper mapper = new ObjectMapper();

    private CompanyAddressTaskService service() {
        return new CompanyAddressTaskService(mapper, root.toString(), root.toString(), false,
                "missing-node-fixture", "", "gpt-6-astra", "medium", 120, "http://127.0.0.1:7890/jd-collector/api");
    }

    private Path job(String id) { return root.resolve("jobs").resolve(id); }

    @Test void optimizationCompletionIsDurableDeduplicatedAndDoesNotBlockTheNextCompany() throws Exception {
        AtomicInteger starts = new AtomicInteger();
        var service = new CompanyAddressTaskService(mapper, root.toString(), root.toString(), true,
                "missing-node-fixture", "", "gpt-6-astra", "medium", 120, "http://127.0.0.1:7890/jd-collector/api") {
            @Override protected Process startWorker(List<String> command, Path attempt) throws IOException {
                starts.incrementAndGet();
                throw new IOException("Isolated worker fixture");
            }
        };
        String id = service.create(1L, "地址异常夹具").path("taskId").asText();
        ObjectNode current = state(id);
        current.put("status", "RUNNING"); current.put("attempt", 1);
        current.put("startedAt", "2026-01-01T00:00:00Z"); save(current);
        Path attempt = job(id).resolve("attempt-1"); Files.createDirectories(attempt);
        ObjectNode completion = mapper.createObjectNode();
        completion.put("status", "OPTIMIZATION_PENDING"); completion.put("attempt", 1);
        completion.put("message", "已记录优化任务"); completion.put("errorCode", "INVALID_RESULT");
        completion.putArray("optimizationTasks").addObject().put("optimizationId", "wf-fixture");
        Files.write(attempt.resolve("completion.json"), mapper.writeValueAsBytes(completion));
        var row = service.detail(id);
        assertEquals("OPTIMIZATION_PENDING", row.path("status").asText());
        assertEquals("wf-fixture", row.path("optimizationTasks").get(0).path("optimizationId").asText());
        assertEquals("OPTIMIZATION_PENDING", state(id).path("status").asText());
        assertEquals(id, service.create(1L, "地址异常夹具").path("taskId").asText());
        service.create(2L, "下一家公司");
        service.poll();
        assertEquals(1, starts.get());
        assertEquals("OPTIMIZATION_PENDING", state(id).path("status").asText());
        assertEquals("QUEUED", service.retry(id).path("status").asText());
        assertTrue(Files.exists(attempt.resolve("completion.json")));
    }

    private ObjectNode state(String id) throws IOException {
        return (ObjectNode) mapper.readTree(Files.readAllBytes(job(id).resolve("state.json")));
    }

    private void save(ObjectNode state) throws IOException {
        Files.write(job(state.path("taskId").asText()).resolve("state.json"), mapper.writeValueAsBytes(state));
    }

    private String duplicate(String original, String status, String createdAt) throws IOException {
        String id = UUID.randomUUID().toString();
        Files.createDirectories(job(id));
        ObjectNode copy = state(original);
        copy.put("taskId", id);
        copy.put("tabKey", "company-address:" + id);
        copy.put("status", status);
        copy.put("createdAt", createdAt);
        save(copy);
        Files.write(job(id).resolve("task.json"), mapper.writeValueAsBytes(copy));
        return id;
    }

    @Test void pausedCreationAndRepeatedRetriesKeepTaskAndCheckpointAcrossRestart() throws Exception {
        var service = service();
        String id = service.create(1L, "地址任务夹具").path("taskId").asText();
        Files.writeString(job(id).resolve("graph.checkpoint"), "checkpoint-fixture");
        for (int attempt = 1; attempt <= 3; attempt++) {
            ObjectNode state = state(id);
            state.put("status", "WAITING_USER");
            state.put("attempt", attempt);
            state.put("errorCode", "CLIENT_UPGRADE_REQUIRED");
            save(state);
            var restarted = service();
            assertEquals(id, restarted.create(1L, "地址任务夹具").path("taskId").asText());
            var retried = restarted.retry(id);
            assertEquals(id, retried.path("taskId").asText());
            assertEquals(attempt, retried.path("attempt").asInt());
            assertEquals("QUEUED", retried.path("status").asText());
            assertEquals(1, restarted.list().size());
        }
        try (var files = Files.list(root.resolve("jobs"))) { assertEquals(1, files.count()); }
        assertEquals("checkpoint-fixture", Files.readString(job(id).resolve("graph.checkpoint")));
    }

    @Test void legacyDuplicatesJoinRunningTaskWithoutInterruptingWorkerOrDeletingHistory() throws Exception {
        var service = service();
        String old = service.create(1L, "地址任务夹具").path("taskId").asText();
        ObjectNode first = state(old);
        first.put("status", "WAITING_USER"); first.put("createdAt", "2026-01-01T00:00:00Z"); save(first);
        String queued = duplicate(old, "QUEUED", "2026-01-02T00:00:00Z");
        String running = duplicate(old, "RUNNING", "2026-01-01T12:00:00Z");
        ObjectNode active = state(running);
        active.put("pid", ProcessHandle.current().pid());
        active.put("processStartedAt", ProcessHandle.current().info().startInstant().orElseThrow().toString());
        save(active);
        assertEquals(running, service.list().get(0).path("taskId").asText());
        assertEquals("SUPERSEDED", state(old).path("status").asText());
        assertEquals("SUPERSEDED", state(queued).path("status").asText());
        assertEquals(running, service.retry(old).path("taskId").asText());
        assertEquals(running, service.create(1L, "地址任务夹具").path("taskId").asText());
        assertEquals("RUNNING", state(running).path("status").asText());
        assertTrue(Files.exists(job(old).resolve("task.json")));
        assertTrue(Files.exists(job(queued).resolve("task.json")));
        assertEquals(1, service.list().size());
    }

    @Test void successfulCurrentTaskRetiresOldPauseAndAllowsAnExplicitNewLookup() throws Exception {
        var service = service();
        String old = service.create(1L, "地址任务夹具").path("taskId").asText();
        ObjectNode first = state(old);
        first.put("status", "WAITING_USER"); first.put("createdAt", "2026-01-01T00:00:00Z"); save(first);
        String success = duplicate(old, "SUCCEEDED", "2026-01-02T00:00:00Z");
        assertEquals(success, service.retry(old).path("taskId").asText());
        assertEquals("SUCCEEDED", state(success).path("status").asText());
        String next = service.create(1L, "地址任务夹具").path("taskId").asText();
        assertTrue(!next.equals(success));
        assertEquals(next, service.list().get(0).path("taskId").asText());
        assertEquals(next, service.create(1L, "地址任务夹具").path("taskId").asText());
        assertEquals(1, service.list().size());
        assertEquals("SUCCEEDED", state(success).path("status").asText());
    }

    @Test void duplicateQueuedHistoryCannotBeScheduledAndOtherCompaniesRemainSeparate() throws Exception {
        AtomicInteger starts = new AtomicInteger();
        var service = new CompanyAddressTaskService(mapper, root.toString(), root.toString(), true,
                "missing-node-fixture", "", "gpt-6-astra", "medium", 120, "http://127.0.0.1:7890/jd-collector/api") {
            @Override protected Process startWorker(List<String> command, Path attempt) throws IOException {
                starts.incrementAndGet();
                throw new IOException("Worker must not start for archived duplicate");
            }
        };
        String old = service.create(1L, "地址任务夹具").path("taskId").asText();
        ObjectNode first = state(old); first.put("createdAt", "2026-01-01T00:00:00Z"); save(first);
        duplicate(old, "WAITING_USER", "2026-01-02T00:00:00Z");
        service.poll();
        assertEquals(0, starts.get());
        assertEquals("SUPERSEDED", state(old).path("status").asText());
        service.create(2L, "另一家公司");
        assertEquals(2, service.list().size());
    }

    @Test void durableBatchGateStopsDispatchAndRespectsItsOrderWithoutLaunchingUnrelatedTasks() throws Exception {
        var starts = new java.util.ArrayList<String>();
        var service = new CompanyAddressTaskService(mapper, root.toString(), root.toString(), true,
                "missing-node-fixture", "", "gpt-6-astra", "medium", 120, "http://127.0.0.1:7890/jd-collector/api") {
            @Override protected Process startWorker(List<String> command, Path attempt) throws IOException {
                starts.add(attempt.getParent().getFileName().toString()); throw new IOException("isolated fixture");
            }
        };
        String first = service.create(1L, "第一家").path("taskId").asText();
        String second = service.create(2L, "第二家").path("taskId").asText();
        service.create(3L, "不在批次内");
        var batch = mapper.createObjectNode(); batch.put("status", "STOPPED");
        var entries = batch.putArray("entries");
        entries.addObject().put("taskId", second); entries.addObject().put("taskId", first);
        service.writeBatch(batch); service.poll(); assertTrue(starts.isEmpty());
        batch.put("status", "RUNNING"); service.writeBatch(batch); service.poll();
        assertEquals(List.of(second), starts); service.poll();
        assertEquals(List.of(second, first), starts); service.poll();
        assertEquals(2, starts.size());
        assertEquals("QUEUED", service.list().stream().filter(t -> t.path("companyId").asLong() == 3).findFirst().orElseThrow().path("status").asText());
    }
}
