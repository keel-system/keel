package com.example.inventory.web;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestTemplate;

@RestController
public class StockController {

    @Value("${pricing.url}")
    private String pricingUrl;

    @Value("${http.timeout" + ":5}")
    private int timeout;

    private final RestTemplate restTemplate = new RestTemplate();
    private final String region = System.getenv("REGION");

    public Object price(String sku) {
        // http://ejemplo-en-comentario.invalid no es una dependencia
        return restTemplate.getForObject(pricingUrl + "/" + sku, Object.class);
    }
}
