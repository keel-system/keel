package com.example.billing;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.client.RestTemplate;

public class TaxClient {

    @Value("${tax.url}")
    private String taxUrl;

    @Value("${billing.currency:EUR}")
    private String currency;

    private final RestTemplate restTemplate = new RestTemplate();

    public Object rates() {
        return restTemplate.postForEntity(taxUrl, currency, Object.class);
    }
}
