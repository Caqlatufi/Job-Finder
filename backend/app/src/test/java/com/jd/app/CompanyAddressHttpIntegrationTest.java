package com.jd.app;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.List;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class CompanyAddressHttpIntegrationTest {
    @LocalServerPort int port;
    @Autowired ObjectMapper mapper;
    @Autowired JdbcTemplate jdbc;
    final HttpClient client = HttpClient.newHttpClient();
    static final Path DIRECTORY = directory();
    static HttpServer geocoder;

    static Path directory() {
        try { return Files.createTempDirectory("company-address-http-"); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }

    @DynamicPropertySource static void properties(DynamicPropertyRegistry registry) throws Exception {
        registry.add("jd-collector.company-address.work-directory", DIRECTORY::toString);
        registry.add("spring.datasource.url", () -> "jdbc:h2:mem:company_address_test;MODE=MySQL;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE;DATABASE_TO_LOWER=TRUE");
        geocoder = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        geocoder.createContext("/api/", exchange -> {
            String query = java.net.URLDecoder.decode(exchange.getRequestURI().getRawQuery(), StandardCharsets.UTF_8);
            String json = query.contains("匹配失败") ? "{\"features\":[]}"
                    : "{\"features\":[{\"properties\":{\"state\":\"上海市\",\"name\":\"收录测试大厦\"},\"geometry\":{\"coordinates\":[121.437,31.19]}}]}";
            byte[] body = json.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (var stream = exchange.getResponseBody()) { stream.write(body); }
        });
        geocoder.start();
        registry.add("jd-collector.company.geocoder-url", () -> "http://127.0.0.1:" + geocoder.getAddress().getPort() + "/api/");
    }

    @AfterAll static void closeGeocoder() { if (geocoder != null) geocoder.stop(0); }

    private HttpResponse<String> request(String method, String path, Object body) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/jd-collector/api" + path))
                .header("Content-Type", "application/json");
        builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)));
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }
    private JsonNode result(String method, String path, Object body) throws Exception {
        var response = request(method, path, body);
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return mapper.readTree(response.body()).path("result");
    }
    private long company(String name) throws Exception {
        return result("POST", "/companies", Map.of("name", name, "businessType", "UNKNOWN", "productOwnership", "UNKNOWN",
                "qualityScore", 10, "address", "上海", "notes", "原有资料", "active", true)).path("id").asLong();
    }
    @Test void unrecordedCountUsesCurrentAddressesBeforeStartAndAfterHistoricalCompletionOrManualEdits() throws Exception {
        int before = result("GET", "/company-address-tasks/batch", null).path("unrecorded").asInt();
        String name = "实时未收录计数-" + UUID.randomUUID();
        long id = company(name);
        assertThat(result("GET", "/company-address-tasks/batch", null).path("unrecorded").asInt()).isEqualTo(before + 1);
        String taskId = result("POST", "/company-address-tasks", Map.of("companyId", id)).path("taskId").asText();
        Path stateFile = DIRECTORY.resolve("jobs/" + taskId + "/state.json");
        var task = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(Files.readAllBytes(stateFile));
        task.put("status", "SUCCEEDED"); Files.write(stateFile, mapper.writeValueAsBytes(task));
        Path batchFile = DIRECTORY.resolve("batch.json");
        byte[] original = Files.exists(batchFile) ? Files.readAllBytes(batchFile) : null;
        try {
            var historical = mapper.createObjectNode(); historical.put("status", "COMPLETED");
            historical.put("unrecorded", 66); historical.putArray("entries");
            Files.write(batchFile, mapper.writeValueAsBytes(historical));
            assertThat(result("GET", "/company-address-tasks/batch", null).path("unrecorded").asInt()).isEqualTo(before + 1);
            assertThat(mapper.readTree(Files.readAllBytes(batchFile)).path("unrecorded").asInt()).isEqualTo(66);
            result("PUT", "/companies/" + id, Map.of("name", name, "businessType", "UNKNOWN", "productOwnership", "UNKNOWN",
                    "address", "上海静安区南京西路100号", "active", true));
            // Address text alone is no longer a completed intake: map positioning is required.
            assertThat(result("GET", "/company-address-tasks/batch", null).path("unrecorded").asInt()).isEqualTo(before + 1);
            result("PUT", "/companies/" + id, Map.of("name", name, "businessType", "UNKNOWN", "productOwnership", "UNKNOWN",
                    "address", "上海静安区南京西路100号", "active", true,
                    "workLocations", List.of(Map.of("address", "上海静安区南京西路100号", "longitude", 121.46, "latitude", 31.23))));
            assertThat(result("GET", "/company-address-tasks/batch", null).path("unrecorded").asInt()).isEqualTo(before);
            result("PUT", "/companies/" + id, Map.of("name", name, "businessType", "UNKNOWN", "productOwnership", "UNKNOWN",
                    "address", "上海", "active", true, "workLocations", List.of()));
            assertThat(result("GET", "/company-address-tasks/batch", null).path("unrecorded").asInt()).isEqualTo(before + 1);
        } finally {
            if (original == null) Files.deleteIfExists(batchFile); else Files.write(batchFile, original);
        }
    }

    @Test void batchSelectsUnfinishedIntakeAndExplicitRestartRequeuesFailuresWithoutLosingAttempts() throws Exception {
        long missing = company("批量未收录-" + UUID.randomUUID());
        long known = company("批量已有地址-" + UUID.randomUUID());
        result("PUT", "/companies/" + known, Map.of("name", "批量已有地址-" + known,
                "businessType", "UNKNOWN", "productOwnership", "UNKNOWN", "address", "上海静安区南京西路100号", "active", true,
                "workLocations", List.of(Map.of("address", "上海静安区南京西路100号", "longitude", 121.46, "latitude", 31.23))));
        long jdKnown = company("批量JD地址-" + UUID.randomUUID());
        var postingInput = new HashMap<String, Object>(Map.of("companyId", jdKnown, "title", "地址已知职位", "direction", "FULL_STACK",
                "source", "OTHER", "rawJd", "测试正文", "location", "上海徐汇区宜山路868号"));
        postingInput.putAll(Map.of("matchScore", 0, "companyScore", 0, "freshnessScore", 0, "commuteScore", 0, "salaryScore", 0));
        result("POST", "/postings", postingInput);
        result("PUT", "/companies/" + jdKnown, Map.of("name", "批量JD地址-" + jdKnown,
                "businessType", "UNKNOWN", "productOwnership", "UNKNOWN", "address", "上海", "active", true,
                "workLocations", List.of(Map.of("address", "上海徐汇区宜山路868号", "longitude", 121.43, "latitude", 31.18))));
        long failed = company("批量已记录异常-" + UUID.randomUUID());
        long outside = company("批量仅外地地址-" + UUID.randomUUID());
        result("PUT", "/companies/" + outside, Map.of("name", "批量仅外地地址-" + outside,
                "businessType", "UNKNOWN", "productOwnership", "UNKNOWN", "address", "深圳市南山区", "active", true));
        String failedId = result("POST", "/company-address-tasks", Map.of("companyId", failed)).path("taskId").asText();
        var failedState = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(Files.readAllBytes(DIRECTORY.resolve("jobs/" + failedId + "/state.json")));
        failedState.put("status", "OPTIMIZATION_PENDING"); failedState.put("attempt", 1);
        Files.write(DIRECTORY.resolve("jobs/" + failedId + "/state.json"), mapper.writeValueAsBytes(failedState));
        var batch = result("POST", "/company-address-tasks/batch/start", null);
        String batchId = batch.path("batchId").asText();
        assertThat(result("POST", "/company-address-tasks/batch/start", null).path("batchId").asText()).isEqualTo(batchId);
        var stored = mapper.readTree(Files.readAllBytes(DIRECTORY.resolve("batch.json")));
        var ids = new java.util.ArrayList<Long>();
        String taskId = null;
        for (var entry : stored.path("entries")) {
            ids.add(entry.path("companyId").asLong());
            if (entry.path("companyId").asLong() == missing) taskId = entry.path("taskId").asText();
        }
        assertThat(ids).contains(missing, failed).doesNotContain(known, jdKnown, outside).isSorted();
        assertThat(batch.path("status").asText()).isEqualTo("RUNNING");
        assertThat(result("GET", "/company-address-tasks/" + failedId, null).path("status").asText()).isEqualTo("QUEUED");
        assertThat(result("GET", "/company-address-tasks/" + failedId, null).path("attempt").asInt()).isEqualTo(1);
        Path job = DIRECTORY.resolve("jobs/" + taskId), run = job.resolve("attempt-1"); Files.createDirectories(run);
        var active = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(Files.readAllBytes(job.resolve("state.json")));
        active.put("status", "RUNNING"); active.put("attempt", 1);
        active.put("startedAt", "2026-01-01T00:00:00Z"); active.put("pid", ProcessHandle.current().pid());
        active.put("processStartedAt", ProcessHandle.current().info().startInstant().orElseThrow().toString());
        Files.write(job.resolve("state.json"), mapper.writeValueAsBytes(active));
        assertThat(result("POST", "/company-address-tasks/batch/stop", null).path("status").asText()).isEqualTo("STOPPING");
        assertThat(Files.exists(run.resolve("stop.requested"))).isTrue();
        assertThat(request("POST", "/company-address-tasks/batch/start", null).statusCode()).isEqualTo(409);
        Files.write(run.resolve("completion.json"), mapper.writeValueAsBytes(Map.of("attempt", 1, "status", "STOPPED")));
        active.remove(java.util.List.of("pid", "processStartedAt")); Files.write(job.resolve("state.json"), mapper.writeValueAsBytes(active));
        assertThat(result("GET", "/company-address-tasks/batch", null).path("status").asText()).isEqualTo("STOPPED");
        assertThat(mapper.readTree(Files.readAllBytes(DIRECTORY.resolve("batch.json"))).path("status").asText()).isEqualTo("STOPPED");
        result("POST", "/company-address-tasks/batch/start", null);
        assertThat(result("GET", "/company-address-tasks/" + taskId, null).path("status").asText()).isEqualTo("QUEUED");
        assertThat(result("GET", "/company-address-tasks/" + failedId, null).path("attempt").asInt()).isEqualTo(1);
        assertThat(Files.exists(run.resolve("completion.json"))).isTrue();
        result("POST", "/company-address-tasks/batch/stop", null);
    }
    private JsonNode positionWithRealWorker(long company) throws Exception {
        result("POST", "/company-address-tasks/batch/stop", null);
        result("POST", "/company-address-tasks/batch/start", null);
        var batch = mapper.readTree(Files.readAllBytes(DIRECTORY.resolve("batch.json")));
        String id = null;
        for (var entry : batch.path("entries")) if (entry.path("companyId").asLong() == company) id = entry.path("taskId").asText();
        assertThat(id).isNotNull();
        Path job = DIRECTORY.resolve("jobs/" + id);
        var state = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(Files.readAllBytes(job.resolve("state.json")));
        int attempt = state.path("attempt").asInt() + 1;
        state.put("status", "RUNNING"); state.put("attempt", attempt);
        state.put("startedAt", java.time.Instant.now().toString());
        Files.write(job.resolve("state.json"), mapper.writeValueAsBytes(state));
        Path project = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (project != null && !Files.exists(project.resolve("ops/jd-import/address-worker.mjs"))) project = project.getParent();
        assertThat(project).isNotNull();
        Path script = project.resolve("ops/jd-import/address-worker.mjs");
        Path runner = DIRECTORY.resolve("position-runner.mjs");
        Files.writeString(runner, "const {work}=await import(process.argv[2]);"
                + "console.log(JSON.stringify(await work(process.argv[3],Number(process.argv[4]),{apiBase:process.argv[5],"
                + "optimizationRoot:process.argv[6],codex:'fixture-model-must-not-run',timeout:1000})));", StandardCharsets.UTF_8);
        Path log = job.resolve("position-worker.log");
        var worker = new ProcessBuilder("node", runner.toString(), script.toUri().toString(), job.toString(), Integer.toString(attempt),
                "http://127.0.0.1:" + port + "/jd-collector/api", DIRECTORY.resolve("optimizations").toString())
                .redirectErrorStream(true).redirectOutput(log.toFile()).start();
        boolean finished = worker.waitFor(45, TimeUnit.SECONDS);
        if (!finished) worker.destroyForcibly();
        try {
            assertThat(finished).as(Files.readString(log)).isTrue();
            assertThat(worker.exitValue()).as(Files.readString(log)).isZero();
            return result("GET", "/company-address-tasks/" + id, null);
        } finally {
            Path completion = job.resolve("attempt-" + attempt + "/completion.json");
            if (!Files.exists(completion)) Files.write(completion, mapper.writeValueAsBytes(Map.of("attempt", attempt, "status", "FAILED")));
            result("GET", "/company-address-tasks/" + id, null);
            result("POST", "/company-address-tasks/batch/stop", null);
        }
    }

    @Test void existingMultipleAddressesArePositionedThroughRealWorkerHttpAndCacheWithoutOpeningBrowser() throws Exception {
        long id = company("已有地址自动定位-" + UUID.randomUUID());
        String first = "上海市徐汇区收录测试大厦1号", second = "上海市徐汇区收录测试大厦2号";
        result("PUT", "/companies/" + id, Map.of("name", "已有地址自动定位-" + id, "businessType", "UNKNOWN",
                "productOwnership", "UNKNOWN", "address", first, "active", true,
                "workLocations", List.of(Map.of("address", first.replace("上海市", "上海")), Map.of("address", second))));
        var plan = result("GET", "/company-address-tasks/companies/" + id + "/plan", null);
        assertThat(plan.path("addresses").size()).isEqualTo(2);
        assertThat(plan.path("pendingAddresses").size()).isEqualTo(2);
        var completion = positionWithRealWorker(id);
        assertThat(completion.path("status").asText()).isEqualTo("SUCCEEDED");
        assertThat(completion.path("positioned").asBoolean()).isTrue();
        assertThat(result("GET", "/company-address-tasks/companies/" + id + "/plan", null).path("pendingAddresses").size()).isZero();
        assertThat(jdbc.queryForObject("select count(*) from jd_company_location_cache where address in (?, ?) and longitude is not null", Integer.class, first, second)).isEqualTo(2);
        assertThat(jdbc.queryForObject("select count(*) from jd_company_address_discovery where company_id = ?", Integer.class, id)).isZero();
    }

    @Test void noCoordinateMatchIsNotSuccessfulIntakeAndKeepsAddressWithOptimizationEvidence() throws Exception {
        long id = company("坐标未匹配-" + UUID.randomUUID());
        String address = "上海市徐汇区匹配失败大厦99号";
        result("PUT", "/companies/" + id, Map.of("name", "坐标未匹配-" + id, "businessType", "UNKNOWN",
                "productOwnership", "UNKNOWN", "address", address, "active", true));
        var completion = positionWithRealWorker(id);
        assertThat(completion.path("status").asText()).isEqualTo("OPTIMIZATION_PENDING");
        assertThat(completion.path("positioned").asBoolean()).isFalse();
        assertThat(completion.path("optimizationTasks").get(0).path("errorCode").asText()).isEqualTo("GEOCODING_NO_MATCH");
        assertThat(result("GET", "/companies/" + id, null).path("address").asText()).isEqualTo(address);
        assertThat(result("GET", "/company-address-tasks/companies/" + id + "/plan", null).path("pendingAddresses").size()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from jd_company_location_cache where address = ? and longitude is null", Integer.class, address)).isEqualTo(1);
        assertThat(Files.exists(DIRECTORY.resolve("optimizations"))).isTrue();
    }

    @Test void latestJdAndClosedAddressFailureBelongToPostingAndPreserveCompanyAndOtherJobs() throws Exception {
        String name = "最新JD地址-" + UUID.randomUUID();
        long company = company(name);
        var beforeCompany = result("GET", "/companies/" + company, null);
        var body = new HashMap<String, Object>(Map.of("companyId", company, "title", "较旧高分职位", "direction", "FULL_STACK",
                "source", "OTHER", "rawJd", "地址关闭测试正文", "matchScore", 35, "companyScore", 20,
                "freshnessScore", 15, "commuteScore", 15, "salaryScore", 15));
        body.put("sourceUrl", "https://careers.example.com/old-" + UUID.randomUUID());
        body.put("location", "上海");
        long old = result("POST", "/postings", body).path("id").asLong();
        body.put("title", "最新低分职位");
        String url = "https://careers.example.com/new-" + UUID.randomUUID();
        body.put("sourceUrl", url); body.put("matchScore", 0); body.put("companyScore", 0);
        var latest = result("POST", "/postings", body);
        long id = latest.path("id").asLong();
        jdbc.update("update jd_posting set created_at = '2026-01-01 00:00:00' where id = ?", old);
        jdbc.update("update jd_posting set created_at = '2026-02-01 00:00:00' where id = ?", id);
        assertThat(result("GET", "/postings?companyId=" + company + "&size=1&sortBy=LATEST", null).get(0).path("id").asLong()).isEqualTo(id);
        assertThat(result("GET", "/postings?companyId=" + company + "&size=1", null).get(0).path("id").asLong()).isEqualTo(old);
        var input = new HashMap<String, Object>(Map.of("expectedCompanyId", company, "expectedTitle", "最新低分职位",
                "expectedSourceUrl", url, "status", "JD_CLOSED", "message", "JD 已关闭，地址获取失败",
                "evidence", "最新低分职位：该职位已关闭；截图证据c1"));
        result("POST", "/postings/" + id + "/address-lookup", input);
        var after = result("GET", "/postings/" + id, null);
        assertThat(after.path("addressLookupStatus").asText()).isEqualTo("JD_CLOSED");
        assertThat(after.path("addressLookupSourceUrl").asText()).isEqualTo(url);
        assertThat(after.path("addressLookupEvidence").asText()).contains("该职位已关闭");
        assertThat(after.path("addressLookupCheckedAt").asText()).isNotBlank();
        assertThat(jdbc.queryForObject("select address_lookup_status from jd_posting where id = ?", String.class, id)).isEqualTo("JD_CLOSED");
        for (String field : new String[]{"rawJd", "location", "totalScore", "tier", "stage", "riskNotes", "sourceUrl"})
            assertThat(after.path(field)).as(field).isEqualTo(latest.path(field));
        assertThat(result("GET", "/companies/" + company, null)).isEqualTo(beforeCompany);
        assertThat(result("GET", "/postings/" + old, null).path("addressLookupStatus").asText("")).isEmpty();
        input.put("expectedCompanyId", company + 1);
        assertThat(request("POST", "/postings/" + id + "/address-lookup", input).statusCode()).isEqualTo(409);
        input.put("expectedCompanyId", company); input.put("expectedSourceUrl", url + "-stale");
        assertThat(request("POST", "/postings/" + id + "/address-lookup", input).statusCode()).isEqualTo(409);
        input.put("expectedSourceUrl", url); input.put("status", "ARBITRARY");
        assertThat(request("POST", "/postings/" + id + "/address-lookup", input).statusCode()).isEqualTo(400);
        var reset = result("PUT", "/postings/" + id + "/source-url", Map.of("sourceUrl", url + "-changed", "expectedSourceUrl", url));
        assertThat(reset.path("addressLookupStatus").asText("")).isEmpty();
        assertThat(reset.path("addressLookupEvidence").asText("")).isEmpty();
        assertThat(jdbc.queryForObject("select address_lookup_status from jd_posting where id = ?", String.class, id)).isNull();
    }

    @Test void optimizationCompletionIsReturnedByRealHttpAndPersistedWithoutWaitingForUser() throws Exception {
        long company = company("自动流程异常-" + UUID.randomUUID());
        String id = result("POST", "/company-address-tasks", Map.of("companyId", company)).path("taskId").asText();
        Path job = DIRECTORY.resolve("jobs").resolve(id), attempt = job.resolve("attempt-1");
        Files.createDirectories(attempt);
        var state = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(Files.readAllBytes(job.resolve("state.json")));
        state.put("status", "RUNNING"); state.put("attempt", 1); state.put("startedAt", "2026-01-01T00:00:00Z");
        Files.write(job.resolve("state.json"), mapper.writeValueAsBytes(state));
        Path taskSheet = attempt.resolve("TASK.md"); Files.writeString(taskSheet, "# 优化截图失败分支");
        var completion = mapper.createObjectNode();
        completion.put("attempt", 1); completion.put("status", "OPTIMIZATION_PENDING");
        completion.put("message", "已记录优化任务"); completion.put("errorCode", "INVALID_CAPTURE_RECT");
        completion.putArray("optimizationTasks").addObject().put("optimizationId", "wf-http-fixture")
                .put("taskFile", taskSheet.toString()).put("node", "capture");
        Files.write(attempt.resolve("completion.json"), mapper.writeValueAsBytes(completion));
        var response = result("GET", "/company-address-tasks/" + id, null);
        assertThat(response.path("status").asText()).isEqualTo("OPTIMIZATION_PENDING");
        assertThat(response.path("optimizationTasks").get(0).path("taskFile").asText()).isEqualTo(taskSheet.toString());
        assertThat(mapper.readTree(Files.readAllBytes(job.resolve("state.json"))).path("status").asText()).isEqualTo("OPTIMIZATION_PENDING");
        assertThat(result("POST", "/company-address-tasks", Map.of("companyId", company)).path("taskId").asText()).isEqualTo(id);
        assertThat(Files.readString(taskSheet)).contains("截图失败");
    }

    private Map<String, Object> evidence(String name, String url) {
        return new HashMap<>(Map.of("expectedCompanyName", name, "address", "上海市徐汇区虹梅路1801号",
                "sourceUrl", url, "evidenceText", name + "上海办公地点：虹梅路1801号；截图c1", "taskId", UUID.randomUUID().toString()));
    }

    @Test void queueIsDurableDeduplicatedAndRejectsInvalidCompanyAndRunningRetry() throws Exception {
        String name = "地址队列公司-" + UUID.randomUUID();
        long id = company(name);
        var first = result("POST", "/company-address-tasks", Map.of("companyId", id));
        assertThat(first.path("status").asText()).isEqualTo("QUEUED");
        String task = first.path("taskId").asText();
        assertThat(result("POST", "/company-address-tasks", Map.of("companyId", id)).path("taskId").asText()).isEqualTo(task);
        assertThat(result("GET", "/company-address-tasks/" + task, null).path("companyName").asText()).isEqualTo(name);
        assertThat(Files.isRegularFile(DIRECTORY.resolve("jobs").resolve(task).resolve("task.json"))).isTrue();
        assertThat(request("POST", "/company-address-tasks/" + task + "/retry", null).statusCode()).isEqualTo(409);
        assertThat(request("POST", "/company-address-tasks", Map.of("companyId", -1)).statusCode()).isEqualTo(400);
        assertThat(request("POST", "/company-address-tasks", Map.of("companyId", 999999)).statusCode()).isEqualTo(404);
    }

    @Test void companyReferenceIsIdempotentAndDoesNotOverwriteCompanyOrJd() throws Exception {
        String name = "公司地址证据-" + UUID.randomUUID();
        long id = company(name);
        var before = result("GET", "/companies/" + id, null);
        var input = evidence(name, "https://cn.bing.com/search?q=fixture");
        var saved = result("POST", "/companies/" + id + "/address-discoveries", input);
        assertThat(saved.path("sourceType").asText()).isEqualTo("COMPANY");
        assertThat(saved.path("postingId").isNull() || saved.path("postingId").isMissingNode()).isTrue();
        assertThat(result("POST", "/companies/" + id + "/address-discoveries", input).path("id")).isEqualTo(saved.path("id"));
        assertThat(jdbc.queryForObject("select count(*) from jd_company_address_discovery where company_id = ?", Integer.class, id)).isEqualTo(1);
        assertThat(result("GET", "/companies/" + id, null)).isEqualTo(before);
        input.put("address", "上海·闵行区");
        assertThat(request("POST", "/companies/" + id + "/address-discoveries", input).statusCode()).isEqualTo(400);
        input.put("address", "北京市朝阳区建国路1号");
        assertThat(request("POST", "/companies/" + id + "/address-discoveries", input).statusCode()).isEqualTo(400);
        input.put("address", "上海市徐汇区虹梅路1801号");
        input.put("expectedCompanyName", "其他公司");
        assertThat(request("POST", "/companies/" + id + "/address-discoveries", input).statusCode()).isEqualTo(409);
    }

    @Test void pausedTaskAndConcurrentCreationReuseIdentityAndRetryUpdatesTheSameRow() throws Exception {
        long company = company("地址接续公司-" + UUID.randomUUID());
        String id = result("POST", "/company-address-tasks", Map.of("companyId", company)).path("taskId").asText();
        Path stateFile = DIRECTORY.resolve("jobs").resolve(id).resolve("state.json");
        for (int attempt = 1; attempt <= 3; attempt++) {
            var state = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(Files.readAllBytes(stateFile));
            state.put("status", "WAITING_USER");
            state.put("attempt", attempt);
            state.put("errorCode", "CLIENT_UPGRADE_REQUIRED");
            Files.write(stateFile, mapper.writeValueAsBytes(state));
            var requests = java.util.stream.IntStream.range(0, 6).mapToObj(n ->
                    java.util.concurrent.CompletableFuture.supplyAsync(() -> {
                        try { return result("POST", "/company-address-tasks", Map.of("companyId", company)); }
                        catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
                    })).toList();
            for (var request : requests) assertThat(request.join().path("taskId").asText()).isEqualTo(id);
            var retried = result("POST", "/company-address-tasks/" + id + "/retry", null);
            assertThat(retried.path("taskId").asText()).isEqualTo(id);
            assertThat(retried.path("status").asText()).isEqualTo("QUEUED");
            assertThat(retried.path("attempt").asInt()).isEqualTo(attempt);
            long count = java.util.stream.StreamSupport.stream(result("GET", "/company-address-tasks", null).spliterator(), false)
                    .filter(task -> task.path("companyId").asLong() == company).count();
            assertThat(count).isEqualTo(1);
            assertThat(mapper.readTree(Files.readAllBytes(stateFile)).path("status").asText()).isEqualTo("QUEUED");
        }
    }

    @Test void jdAddressUpdatesOnlyLocationAndEvidenceWithSourceAndConcurrencyChecks() throws Exception {
        String name = "岗位地址证据-" + UUID.randomUUID(), url = "https://careers.example.com/jobs/" + UUID.randomUUID();
        long company = company(name);
        var body = new HashMap<String, Object>(Map.of("companyId", company, "title", "地址验证工程师", "direction", "FULL_STACK",
                "source", "OTHER", "rawJd", "真实HTTP夹具正文", "matchScore", 25, "companyScore", 10, "freshnessScore", 0, "commuteScore", 0, "salaryScore", 0));
        body.put("sourceUrl", url); body.put("location", "上海");
        var before = result("POST", "/postings", body);
        long id = before.path("id").asLong();
        var input = evidence(name, url);
        input.put("expectedPostingUrl", url); input.put("expectedLocation", "上海");
        var saved = result("POST", "/postings/" + id + "/address-discoveries", input);
        assertThat(saved.path("sourceType").asText()).isEqualTo("JD");
        assertThat(saved.path("postingId").asLong()).isEqualTo(id);
        var after = result("GET", "/postings/" + id, null);
        assertThat(after.path("location").asText()).isEqualTo(input.get("address"));
        for (String field : new String[]{"rawJd", "totalScore", "tier", "stage", "riskNotes", "appliedAt", "sourceUrl"})
            assertThat(after.path(field)).as(field).isEqualTo(before.path(field));
        assertThat(jdbc.queryForObject("select location from jd_posting where id = ?", String.class, id)).isEqualTo(input.get("address"));
        input.put("address", "上海市浦东新区张江路100号");
        assertThat(request("POST", "/postings/" + id + "/address-discoveries", input).statusCode()).isEqualTo(409);
        input.put("sourceUrl", "https://unrelated.example.com/");
        assertThat(request("POST", "/postings/" + id + "/address-discoveries", input).statusCode()).isEqualTo(409);
    }

    @Test void legacyDuplicatesAreRetiredAndStaleRetryJoinsCurrentTaskOverHttp() throws Exception {
        long company = company("地址历史合并公司-" + UUID.randomUUID());
        String old = result("POST", "/company-address-tasks", Map.of("companyId", company)).path("taskId").asText();
        Path original = DIRECTORY.resolve("jobs").resolve(old);
        var state = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(Files.readAllBytes(original.resolve("state.json")));
        state.put("status", "WAITING_USER"); state.put("createdAt", "2026-01-01T00:00:00Z");
        Files.write(original.resolve("state.json"), mapper.writeValueAsBytes(state));
        Files.writeString(original.resolve("graph.checkpoint"), "retained-checkpoint");
        String latest = UUID.randomUUID().toString();
        Path duplicate = Files.createDirectories(DIRECTORY.resolve("jobs").resolve(latest));
        state.put("taskId", latest); state.put("tabKey", "company-address:" + latest);
        state.put("createdAt", "2026-01-02T00:00:00Z");
        Files.write(duplicate.resolve("state.json"), mapper.writeValueAsBytes(state));
        Files.write(duplicate.resolve("task.json"), mapper.writeValueAsBytes(state));
        var rows = java.util.stream.StreamSupport.stream(result("GET", "/company-address-tasks", null).spliterator(), false)
                .filter(task -> task.path("companyId").asLong() == company).toList();
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).path("taskId").asText()).isEqualTo(latest);
        assertThat(mapper.readTree(Files.readAllBytes(original.resolve("state.json"))).path("status").asText()).isEqualTo("SUPERSEDED");
        var retried = result("POST", "/company-address-tasks/" + old + "/retry", null);
        assertThat(retried.path("taskId").asText()).isEqualTo(latest);
        assertThat(retried.path("status").asText()).isEqualTo("QUEUED");
        assertThat(result("POST", "/company-address-tasks", Map.of("companyId", company)).path("taskId").asText()).isEqualTo(latest);
        assertThat(Files.readString(original.resolve("graph.checkpoint"))).isEqualTo("retained-checkpoint");
    }
}
