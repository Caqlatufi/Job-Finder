package com.jd.recognition.ctrl;

import com.fasterxml.jackson.databind.JsonNode;
import com.jd.common.rest.RestResultResponse;
import com.jd.company.service.CompanyService;
import com.jd.recognition.service.CompanyAddressTaskService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/company-address-tasks")
@RequiredArgsConstructor
public class CompanyAddressTaskController {
    private final CompanyAddressTaskService service;
    private final CompanyService companies;
    private final com.jd.recognition.service.CompanyAddressBatchService batches;

    @GetMapping("/batch")
    public RestResultResponse<JsonNode> batch() { return RestResultResponse.of(batches.status()); }

    @PostMapping("/batch/start")
    public RestResultResponse<JsonNode> startBatch() { return RestResultResponse.of(batches.start()); }

    @PostMapping("/batch/stop")
    public RestResultResponse<JsonNode> stopBatch() { return RestResultResponse.of(batches.stop()); }

    @GetMapping("/companies/{companyId}/plan")
    public RestResultResponse<com.jd.recognition.service.CompanyAddressBatchService.IntakePlan> plan(@PathVariable Long companyId) {
        return RestResultResponse.of(batches.plan(companyId));
    }

    public record CreateRequest(@NotNull @Positive Long companyId) { }

    @PostMapping
    public RestResultResponse<JsonNode> create(@Valid @RequestBody CreateRequest request) {
        var company = companies.get(request.companyId());
        return RestResultResponse.of(service.create(company.id(), company.name()));
    }

    @GetMapping
    public RestResultResponse<List<JsonNode>> list() { return RestResultResponse.of(service.list()); }

    @GetMapping("/{id}")
    public RestResultResponse<JsonNode> detail(@PathVariable String id) { return RestResultResponse.of(service.detail(id)); }

    @PostMapping("/{id}/retry")
    public RestResultResponse<JsonNode> retry(@PathVariable String id) { return RestResultResponse.of(service.retry(id)); }
}
