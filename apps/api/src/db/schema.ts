import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "operator", "reviewer"] }).notNull(),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at").notNull().default(""),
});

export const batches = sqliteTable(
  "batches",
  {
    id: text("id").primaryKey(),
    filePath: text("file_path").notNull(),
    fileName: text("file_name").notNull(),
    mode: text("mode", { enum: ["mock", "test_api", "production_api"] }).notNull(),
    status: text("status", {
      enum: ["uploaded", "matched", "inventory_synced", "review_generated", "reviewed", "exported"],
    }).notNull(),
    orderLineCount: integer("order_line_count").notNull().default(0),
    uniqueBarcodeCount: integer("unique_barcode_count").notNull().default(0),
    matchedBarcodeCount: integer("matched_barcode_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("batches_created_at_idx").on(table.createdAt)],
);

export const reviewLines = sqliteTable(
  "review_lines",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    orderNoticeNo: text("order_notice_no").notNull(),
    excelRow: integer("excel_row").notNull(),
    storeNo: text("store_no").notNull(),
    storeName: text("store_name").notNull(),
    uploadTime: text("upload_time").notNull(),
    orderApprovalNo: text("order_approval_no").notNull().default(""),
    readingStatus: text("reading_status").notNull().default(""),
    deliveryMode: text("delivery_mode").notNull().default(""),
    orderStatus: text("order_status").notNull().default(""),
    deliveryTarget: text("delivery_target").notNull().default(""),
    category: text("category").notNull().default(""),
    orderDate: text("order_date").notNull().default(""),
    deadlineDate: text("deadline_date").notNull().default(""),
    salesperson: text("salesperson").notNull().default(""),
    maker: text("maker").notNull().default(""),
    madeAt: text("made_at").notNull().default(""),
    sourceReviewer: text("source_reviewer").notNull().default(""),
    externalGoodsCode: text("external_goods_code").notNull().default(""),
    externalBarcode: text("external_barcode").notNull(),
    externalGoodsName: text("external_goods_name").notNull(),
    originalSpec: text("original_spec").notNull().default(""),
    transportSpec: text("transport_spec").notNull().default(""),
    orderBoxQty: text("order_box_qty").notNull().default(""),
    taxExcludedUnitPrice: text("tax_excluded_unit_price").notNull().default(""),
    contractPrice: text("contract_price").notNull().default(""),
    taxIncludedUnitPrice: text("tax_included_unit_price").notNull().default(""),
    discountRate: text("discount_rate").notNull().default(""),
    shelfLifeDays: text("shelf_life_days").notNull().default(""),
    receivedQty: text("received_qty").notNull().default(""),
    giftRate: text("gift_rate").notNull().default(""),
    td: text("td").notNull().default(""),
    da: text("da").notNull().default(""),
    pd: text("pd").notNull().default(""),
    spd: text("spd").notNull().default(""),
    rebate: text("rebate").notNull().default(""),
    orderRawJson: text("order_raw_json").notNull().default("{}"),
    goodsName: text("goods_name").notNull().default(""),
    specName: text("spec_name").notNull().default(""),
    wdtSpecNo: text("wdt_spec_no").notNull().default(""),
    matchStatus: text("match_status", { enum: ["matched", "not_found", "ambiguous", "api_error"] }).notNull(),
    matchMessage: text("match_message").notNull().default(""),
    orderQty: real("order_qty").notNull(),
    mainAvailableBefore: real("main_available_before").notNull().default(0),
    nearExpiryAvailableBefore: real("near_expiry_available_before").notNull().default(0),
    suggestedShipQty: real("suggested_ship_qty").notNull(),
    priority: integer("priority").notNull().default(0),
    priorityReason: text("priority_reason").notNull().default(""),
    status: text("status", { enum: ["库存充足", "部分满足", "库存不足", "未匹配"] }).notNull(),
  },
  (table) => [
    index("review_lines_batch_id_idx").on(table.batchId),
    index("review_lines_batch_sort_idx").on(table.batchId, table.sortOrder),
  ],
);

export const reviewDecisions = sqliteTable(
  "review_decisions",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    reviewLineId: text("review_line_id").notNull(),
    reviewerId: text("reviewer_id"),
    decision: text("decision", { enum: ["pending", "ship", "do_not_ship"] }).notNull(),
    approvedShipQty: real("approved_ship_qty").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("review_decisions_batch_id_idx").on(table.batchId),
    uniqueIndex("review_decisions_review_line_id_unique").on(table.reviewLineId),
  ],
);

export const exportsTable = sqliteTable(
  "exports",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    type: text("type", { enum: ["review", "confirmed", "wdt_import"] }).notNull(),
    status: text("status", { enum: ["created", "ready", "failed"] }).notNull(),
    fileName: text("file_name").notNull(),
    filePath: text("file_path").notNull().default(""),
    errorMessage: text("error_message").notNull().default(""),
    createdByUserId: text("created_by_user_id"),
    createdByUsername: text("created_by_username"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("exports_batch_id_idx").on(table.batchId)],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);

export const warehouseUsageSettings = sqliteTable("warehouse_usage_settings", {
  id: text("id").primaryKey(),
  includeMainWarehouse: integer("include_main_warehouse").notNull().default(1),
  includeNearExpiryWarehouse: integer("include_near_expiry_warehouse").notNull().default(1),
  includeDefectWarehouse: integer("include_defect_warehouse").notNull().default(0),
  includeOtherWarehouses: integer("include_other_warehouses").notNull().default(0),
  updatedByUserId: text("updated_by_user_id"),
  updatedByUsername: text("updated_by_username"),
  updatedAt: text("updated_at").notNull(),
});

export const storeAddresses = sqliteTable(
  "store_addresses",
  {
    id: text("id").primaryKey(),
    storeNo: text("store_no").notNull().default(""),
    storeName: text("store_name").notNull(),
    normalizedStoreName: text("normalized_store_name").notNull().default(""),
    receiver: text("receiver").notNull().default(""),
    phone: text("phone").notNull().default(""),
    address: text("address").notNull(),
    isVip: integer("is_vip").notNull().default(0),
    note: text("note").notNull().default(""),
    sourceSheet: text("source_sheet").notNull().default(""),
    sourceRow: integer("source_row").notNull().default(0),
    importedAt: text("imported_at").notNull().default(""),
    rawJson: text("raw_json").notNull().default("{}"),
    updatedByUserId: text("updated_by_user_id"),
    updatedByUsername: text("updated_by_username"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("store_addresses_store_no_idx").on(table.storeNo),
    index("store_addresses_normalized_store_name_idx").on(table.normalizedStoreName),
    index("store_addresses_updated_at_idx").on(table.updatedAt),
  ],
);

export const wdtGoodsSpecs = sqliteTable(
  "wdt_goods_specs",
  {
    id: text("id").primaryKey(),
    goodsNo: text("goods_no").notNull().default(""),
    goodsName: text("goods_name").notNull().default(""),
    specNo: text("spec_no").notNull(),
    specName: text("spec_name").notNull().default(""),
    specCode: text("spec_code").notNull().default(""),
    barcode: text("barcode").notNull().default(""),
    barcodesJson: text("barcodes_json").notNull().default("[]"),
    deleted: integer("deleted").notNull().default(0),
    modified: text("modified").notNull().default(""),
    rawJson: text("raw_json").notNull().default("{}"),
    syncedAt: text("synced_at").notNull(),
  },
  (table) => [
    uniqueIndex("wdt_goods_specs_spec_no_unique").on(table.specNo),
    index("wdt_goods_specs_barcode_idx").on(table.barcode),
    index("wdt_goods_specs_goods_no_idx").on(table.goodsNo),
    index("wdt_goods_specs_modified_idx").on(table.modified),
  ],
);

export const wdtGoodsSyncRuns = sqliteTable(
  "wdt_goods_sync_runs",
  {
    id: text("id").primaryKey(),
    mode: text("mode", { enum: ["full", "incremental"] }).notNull(),
    status: text("status", { enum: ["running", "success", "failed"] }).notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at").notNull().default(""),
    rangeStart: text("range_start").notNull(),
    rangeEnd: text("range_end").notNull(),
    windowCount: integer("window_count").notNull().default(0),
    pageCount: integer("page_count").notNull().default(0),
    fetchedCount: integer("fetched_count").notNull().default(0),
    upsertedCount: integer("upserted_count").notNull().default(0),
    errorMessage: text("error_message").notNull().default(""),
  },
  (table) => [
    index("wdt_goods_sync_runs_started_at_idx").on(table.startedAt),
    index("wdt_goods_sync_runs_status_idx").on(table.status),
  ],
);

export const productMappings = sqliteTable(
  "product_mappings",
  {
    id: text("id").primaryKey(),
    externalBarcode: text("external_barcode").notNull().default(""),
    externalGoodsName: text("external_goods_name").notNull().default(""),
    externalGoodsCode: text("external_goods_code").notNull().default(""),
    wdtGoodsNo: text("wdt_goods_no").notNull().default(""),
    wdtGoodsName: text("wdt_goods_name").notNull().default(""),
    wdtSpecNo: text("wdt_spec_no").notNull(),
    wdtSpecName: text("wdt_spec_name").notNull().default(""),
    wdtBarcode: text("wdt_barcode").notNull().default(""),
    status: text("status", { enum: ["confirmed", "disabled", "needs_review"] }).notNull(),
    sourceBatchId: text("source_batch_id").notNull().default(""),
    confirmedByUserId: text("confirmed_by_user_id"),
    confirmedAt: text("confirmed_at").notNull().default(""),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("product_mappings_external_barcode_idx").on(table.externalBarcode),
    index("product_mappings_external_goods_code_idx").on(table.externalGoodsCode),
    index("product_mappings_wdt_spec_no_idx").on(table.wdtSpecNo),
  ],
);

export const productMatchCandidates = sqliteTable(
  "product_match_candidates",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull(),
    reviewLineId: text("review_line_id").notNull().default(""),
    externalBarcode: text("external_barcode").notNull().default(""),
    externalGoodsName: text("external_goods_name").notNull().default(""),
    externalGoodsCode: text("external_goods_code").notNull().default(""),
    wdtSpecNo: text("wdt_spec_no").notNull().default(""),
    wdtGoodsNo: text("wdt_goods_no").notNull().default(""),
    wdtGoodsName: text("wdt_goods_name").notNull().default(""),
    wdtSpecName: text("wdt_spec_name").notNull().default(""),
    wdtBarcode: text("wdt_barcode").notNull().default(""),
    score: real("score").notNull().default(0),
    basis: text("basis").notNull().default(""),
    source: text("source").notNull().default("goods"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("product_match_candidates_batch_id_idx").on(table.batchId),
    index("product_match_candidates_review_line_id_idx").on(table.reviewLineId),
  ],
);

export const externalProducts = sqliteTable(
  "external_products",
  {
    id: text("id").primaryKey(),
    type: text("type", { enum: ["normal", "sample", "bundle", "gift"] }).notNull(),
    externalBarcode: text("external_barcode").notNull().default(""),
    externalGoodsCode: text("external_goods_code").notNull().default(""),
    externalGoodsName: text("external_goods_name").notNull().default(""),
    status: text("status", { enum: ["confirmed", "needs_review", "disabled"] }).notNull(),
    sourceFileName: text("source_file_name").notNull().default(""),
    sourceSheet: text("source_sheet").notNull().default(""),
    sourceRow: integer("source_row").notNull().default(0),
    importedAt: text("imported_at").notNull().default(""),
    rawJson: text("raw_json").notNull().default("{}"),
    note: text("note").notNull().default(""),
    updatedByUserId: text("updated_by_user_id"),
    updatedByUsername: text("updated_by_username"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("external_products_type_idx").on(table.type),
    index("external_products_external_barcode_idx").on(table.externalBarcode),
    index("external_products_external_goods_code_idx").on(table.externalGoodsCode),
    index("external_products_updated_at_idx").on(table.updatedAt),
  ],
);

export const externalProductComponents = sqliteTable(
  "external_product_components",
  {
    id: text("id").primaryKey(),
    externalProductId: text("external_product_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    role: text("role", { enum: ["primary", "replacement", "extra"] }).notNull().default("primary"),
    componentBarcode: text("component_barcode").notNull().default(""),
    componentGoodsCode: text("component_goods_code").notNull().default(""),
    componentName: text("component_name").notNull().default(""),
    componentSpec: text("component_spec").notNull().default(""),
    quantityMultiplier: real("quantity_multiplier").notNull().default(1),
    wdtSpecNo: text("wdt_spec_no").notNull().default(""),
    wdtGoodsNo: text("wdt_goods_no").notNull().default(""),
    wdtGoodsName: text("wdt_goods_name").notNull().default(""),
    wdtSpecName: text("wdt_spec_name").notNull().default(""),
    wdtBarcode: text("wdt_barcode").notNull().default(""),
    matchStatus: text("match_status", {
      enum: ["unique_wdt_hit", "no_wdt_hit", "ambiguous_wdt_hit", "deleted_only_wdt_hit", "needs_review"],
    }).notNull(),
    matchMessage: text("match_message").notNull().default(""),
    note: text("note").notNull().default(""),
    sourceSheet: text("source_sheet").notNull().default(""),
    sourceRow: integer("source_row").notNull().default(0),
    rawJson: text("raw_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("external_product_components_product_id_idx").on(table.externalProductId),
    index("external_product_components_component_barcode_idx").on(table.componentBarcode),
    index("external_product_components_wdt_spec_no_idx").on(table.wdtSpecNo),
  ],
);
