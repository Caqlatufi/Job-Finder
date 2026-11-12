package com.jd.posting.ctrl;

import com.jd.common.rest.RestResultResponse;
import com.jd.company.model.CompanyAddressDtos;
import com.jd.posting.service.PostingService;
import com.jd.posting.model.PostingDtos;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/postings/{id}")
@RequiredArgsConstructor
public class PostingAddressController {
    private final PostingService service;

    @PostMapping("/address-discoveries")
    public RestResultResponse<CompanyAddressDtos.Response> save(@PathVariable Long id,
            @Valid @RequestBody CompanyAddressDtos.SaveRequest request) {
        return RestResultResponse.of(service.saveDiscoveredAddress(id, request));
    }

    @PostMapping("/address-lookup")
    public RestResultResponse<PostingDtos.Response> recordLookup(@PathVariable Long id,
            @Valid @RequestBody PostingDtos.AddressLookupRequest request) {
        return RestResultResponse.of(service.recordAddressLookup(id, request));
    }
}
