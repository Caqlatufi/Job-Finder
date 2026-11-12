package com.jd.recognition.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jd.common.exception.BusinessException;
import com.jd.common.exception.ErrorCode;
import com.jd.company.model.CompanyDtos;
import com.jd.company.service.CompanyService;
import com.jd.company.service.CompanyAddressDiscoveryService;
import com.jd.company.service.CompanyGeocodingService;
import com.jd.posting.repo.JobPostingRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** One durable, serial batch. Stop signals belong to the current attempt, never a later replay. */
@RequiredArgsConstructor
public class CompanyAddressBatchService {
    private final ObjectMapper mapper;
    private final CompanyAddressTaskService queue;
    private final CompanyService companies;
    private final CompanyAddressDiscoveryService discoveries;
    private final JobPostingRepository postings;
    private final CompanyGeocodingService geocoding;
    private static final Set<String> ACTIVE = Set.of("RUNNING", "STARTING");

    public JsonNode start() {
        synchronized (queue) {
            try {
                ObjectNode previous = queue.readBatch();
                if (previous != null && "RUNNING".equals(previous.path("status").asText())) return view(previous);
                if (previous != null && "STOPPING".equals(view(previous).path("status").asText()))
                    throw new BusinessException(ErrorCode.CONFLICT, HttpStatus.CONFLICT, "正在停止当前收录，请稍候");
                var missing = pendingPlans();
                var batch = mapper.createObjectNode();
                batch.put("batchId", UUID.randomUUID().toString());
                batch.put("status", "PREPARING");
                batch.put("startedAt", Instant.now().toString());
                batch.put("unrecorded", missing.size());
                var entries = batch.putArray("entries");
                queue.writeBatch(batch); // Disable dispatch until the complete ordered batch is published.
                for (var plan : missing) {
                    var company = plan.company();
                    var task = queue.create(company.id(), company.name());
                    // A deliberate new batch retries each unfinished company once, retaining all earlier attempts.
                    if (!Set.of("QUEUED", "RUNNING", "STARTING").contains(task.path("status").asText()))
                        task = queue.retry(task.path("taskId").asText());
                    var entry = entries.addObject();
                    entry.put("companyId", company.id());
                    entry.put("companyName", company.name());
                    entry.put("taskId", task.path("taskId").asText());
                }
                batch.put("status", "RUNNING");
                queue.writeBatch(batch);
                return view(batch);
            } catch (IOException error) { throw storageError(); }
        }
    }

    public JsonNode status() {
        synchronized (queue) {
            try {
                ObjectNode batch = queue.readBatch();
                if (batch == null) {
                    batch = mapper.createObjectNode(); batch.put("status", "IDLE");
                    batch.putArray("entries"); batch.put("unrecorded", 0);
                }
                return view(batch);
            } catch (IOException error) { throw storageError(); }
        }
    }

    public JsonNode stop() {
        synchronized (queue) {
            try {
                ObjectNode batch = queue.readBatch();
                if (batch == null) { batch = mapper.createObjectNode(); batch.putArray("entries"); }
                batch.put("status", "STOPPING");
                queue.writeBatch(batch); // Stop dispatch first, then cancel only owned workers.
                for (var task : queue.list()) if (ACTIVE.contains(task.path("status").asText())) queue.requestStop(task);
                return view(batch);
            } catch (IOException error) { throw storageError(); }
        }
    }

    private ObjectNode view(ObjectNode batch) throws IOException {
        int completed = 0, succeeded = 0, skipped = 0, remaining = 0;
        String current = "";
        for (var entry : batch.path("entries")) {
            var task = queue.detail(entry.path("taskId").asText());
            String status = task.path("status").asText();
            if (ACTIVE.contains(status)) current = entry.path("companyName").asText();
            else if ("QUEUED".equals(status) || "STOPPED".equals(status)) remaining++;
            else { completed++; if ("SUCCEEDED".equals(status)) succeeded++; else skipped++; }
        }
        // Also wait for a preexisting address worker outside the new candidate snapshot.
        boolean active = queue.list().stream().anyMatch(t -> ACTIVE.contains(t.path("status").asText()));
        String status = batch.path("status").asText();
        if ("RUNNING".equals(status) && remaining == 0 && !active) batch.put("status", "COMPLETED");
        if ("STOPPING".equals(status) && !active) batch.put("status", "STOPPED");
        if (!status.equals(batch.path("status").asText()) && batch.has("batchId")) queue.writeBatch(batch);
        ObjectNode result = batch.deepCopy();
        // The persisted batch is a historical snapshot; the display count is always current address data.
        result.put("unrecorded", pendingPlans().size());
        result.put("total", batch.path("entries").size());
        result.put("completed", completed); result.put("succeeded", succeeded); result.put("skipped", skipped);
        result.put("remaining", remaining + (current.isEmpty() ? 0 : 1)); result.put("currentCompany", current);
        result.remove("entries");
        return result;
    }

    public record IntakePlan(CompanyDtos.Response company, List<String> addresses, List<String> pendingAddresses) { }

    public IntakePlan plan(Long companyId) {
        companies.get(companyId); // Preserve the normal not-found response.
        return plans().stream().filter(plan -> plan.company().id().equals(companyId)).findFirst()
                .orElseThrow(() -> new BusinessException(ErrorCode.CONFLICT, HttpStatus.CONFLICT, "公司当前只有上海以外地点，已跳过"));
    }

    private List<IntakePlan> pendingPlans() {
        return plans().stream().filter(plan -> Boolean.TRUE.equals(plan.company().active()))
                .filter(plan -> plan.addresses().isEmpty() || !plan.pendingAddresses().isEmpty())
                .sorted(Comparator.comparing(plan -> plan.company().id())).toList();
    }

    private List<IntakePlan> plans() {
        var all = new ArrayList<CompanyDtos.Response>();
        int number = 1;
        org.springframework.data.domain.Page<CompanyDtos.Response> page;
        do { page = companies.search("", number++, 100); all.addAll(page.getContent()); } while (page.hasNext());
        var addresses = new LinkedHashMap<Long, Map<String, String>>();
        var positioned = new HashSet<String>();
        for (var position : geocoding.cached()) if (coordinates(position.longitude(), position.latitude()))
            positioned.add(normalize(position.address()));
        var seen = new HashSet<Long>();
        var local = new HashSet<Long>();
        for (var company : all) {
            noteAddress(company.id(), company.address(), seen, local, addresses);
            for (var location : company.workLocations()) {
                noteAddress(company.id(), location.address(), seen, local, addresses);
                if (coordinates(location.longitude(), location.latitude())) positioned.add(normalize(location.address()));
            }
        }
        for (var row : discoveries.list()) noteAddress(row.companyId(), row.address(), seen, local, addresses);
        for (var row : postings.findWorkLocations()) noteAddress(row.getCompanyId(), row.getAddress(), seen, local, addresses);
        return all.stream().filter(c -> !seen.contains(c.id()) || local.contains(c.id()))
                .map(c -> {
                    var detailed = List.copyOf(addresses.getOrDefault(c.id(), Map.of()).values());
                    return new IntakePlan(c, detailed, detailed.stream().filter(a -> !positioned.contains(normalize(a))).toList());
                }).toList();
    }

    private static void noteAddress(Long companyId, String address, Set<Long> seen, Set<Long> local,
            Map<Long, Map<String, String>> addresses) {
        if (address == null || address.isBlank()) return;
        for (String part : address.split("[；;\\n]")) {
            if (part.isBlank() || part.trim().matches("(?i)^JD\\s*Location:.*")) continue;
            seen.add(companyId);
            if (!outside(part.trim())) local.add(companyId);
            if (detailed(part)) addresses.computeIfAbsent(companyId, id -> new LinkedHashMap<>())
                    .putIfAbsent(normalize(part), part.trim());
        }
    }

    private static String normalize(String address) {
        return address.replace("上海市", "上海").replaceAll("[\\s·（）()]", "");
    }

    private static boolean coordinates(Double longitude, Double latitude) {
        return longitude != null && latitude != null && Double.isFinite(longitude) && Double.isFinite(latitude)
                && longitude >= 120.8 && longitude <= 122.2 && latitude >= 30.65 && latitude <= 31.95;
    }

    private static boolean outside(String value) {
        return value != null && value.matches("^(中国)?(北京|天津|重庆|杭州|深圳|广州|苏州|南京|武汉|成都|合肥|厦门|宁波|无锡|西安|济南|青岛|郑州|长沙|福州|东莞|珠海|南昌|昆明|沈阳|大连|贵阳|佛山|南宁|海口).*");
    }

    private static boolean detailed(String value) {
        if (value == null) return false;
        for (String part : value.split("[；;\\n]")) {
            String clean = part.replaceAll("[（(].*?[）)]|[\\s·-]", "").replace("上海市", "上海");
            if (!outside(clean) && !clean.startsWith("JDLocation:") && !clean.matches("(上海)?([\\p{IsHan}]{2,4}区)?|待确认|待核实|尚未填写工作地址")) return true;
        }
        return false;
    }

    private BusinessException storageError() {
        return new BusinessException(ErrorCode.INTERNAL_ERROR, HttpStatus.INTERNAL_SERVER_ERROR, "地址收录批次无法读写");
    }
}
