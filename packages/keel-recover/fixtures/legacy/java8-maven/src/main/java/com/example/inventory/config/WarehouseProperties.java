package com.example.inventory.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "warehouse")
public class WarehouseProperties {
    private static final String UNUSED = "x";
    private String defaultCode = "MAD-1";
    private int maxItems = 50;

    public void setDefaultCode(String defaultCode) {
        this.defaultCode = defaultCode;
    }

    public void setMaxItems(int maxItems) {
        this.maxItems = maxItems;
    }
}
