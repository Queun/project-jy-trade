import { z } from "zod";

export const BatchStatusSchema = z.enum([
  "uploaded",
  "matched",
  "inventory_synced",
  "review_generated",
  "reviewed",
  "exported",
]);
export type BatchStatus = z.infer<typeof BatchStatusSchema>;

export const MatchStatusSchema = z.enum(["matched", "not_found", "ambiguous", "api_error"]);
export type MatchStatus = z.infer<typeof MatchStatusSchema>;

export const ReviewStatusSchema = z.enum(["库存充足", "部分满足", "库存不足", "未匹配"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ReviewDecisionSchema = z.enum(["pending", "ship", "do_not_ship"]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const UserRoleSchema = z.enum(["admin", "operator", "reviewer"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const AuthUserDtoSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: UserRoleSchema,
  createdAt: z.string(),
});
export type AuthUserDto = z.infer<typeof AuthUserDtoSchema>;

export const LoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  user: AuthUserDtoSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const MeResponseSchema = z.object({
  user: AuthUserDtoSchema.nullable(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const BatchSummarySchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mode: z.enum(["mock", "test_api", "production_api"]),
  status: BatchStatusSchema,
  orderLineCount: z.number(),
  uniqueBarcodeCount: z.number(),
  matchedBarcodeCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

export const ReviewLineDtoSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  orderNoticeNo: z.string(),
  excelRow: z.number(),
  storeNo: z.string(),
  storeName: z.string(),
  uploadTime: z.string(),
  orderApprovalNo: z.string(),
  readingStatus: z.string(),
  deliveryMode: z.string(),
  orderStatus: z.string(),
  deliveryTarget: z.string(),
  category: z.string(),
  orderDate: z.string(),
  deadlineDate: z.string(),
  salesperson: z.string(),
  maker: z.string(),
  madeAt: z.string(),
  sourceReviewer: z.string(),
  externalGoodsCode: z.string(),
  externalBarcode: z.string(),
  externalGoodsName: z.string(),
  originalSpec: z.string(),
  transportSpec: z.string(),
  orderBoxQty: z.string(),
  taxExcludedUnitPrice: z.string(),
  contractPrice: z.string(),
  taxIncludedUnitPrice: z.string(),
  discountRate: z.string(),
  shelfLifeDays: z.string(),
  receivedQty: z.string(),
  giftRate: z.string(),
  td: z.string(),
  da: z.string(),
  pd: z.string(),
  spd: z.string(),
  rebate: z.string(),
  orderRawJson: z.string(),
  goodsName: z.string(),
  specName: z.string(),
  wdtSpecNo: z.string(),
  matchStatus: MatchStatusSchema,
  matchMessage: z.string(),
  orderQty: z.number(),
  mainAvailableBefore: z.number(),
  nearExpiryAvailableBefore: z.number(),
  suggestedShipQty: z.number(),
  status: ReviewStatusSchema,
  decision: ReviewDecisionSchema,
  approvedShipQty: z.number(),
  reason: z.string(),
  priority: z.boolean(),
  priorityReason: z.string(),
});
export type ReviewLineDto = z.infer<typeof ReviewLineDtoSchema>;

export const ReviewDecisionDtoSchema = z.object({
  decision: ReviewDecisionSchema,
  approvedShipQty: z.number().min(0),
  reason: z.string().max(500).default(""),
});
export type ReviewDecisionDto = z.infer<typeof ReviewDecisionDtoSchema>;

export const UpdateReviewLinePriorityRequestSchema = z.object({
  priority: z.boolean(),
  reason: z.string().max(500).default(""),
});
export type UpdateReviewLinePriorityRequest = z.infer<typeof UpdateReviewLinePriorityRequestSchema>;

export const ExportDtoSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  type: z.enum(["review", "confirmed", "wdt_import"]),
  status: z.enum(["created", "ready", "failed"]),
  fileName: z.string(),
  downloadUrl: z.string().optional(),
  errorMessage: z.string().nullable().optional(),
  createdByUserId: z.string().nullable().optional(),
  createdByUsername: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type ExportDto = z.infer<typeof ExportDtoSchema>;

export const CreateExportRequestSchema = z.object({
  type: z.enum(["review", "confirmed", "wdt_import"]).default("review"),
});
export type CreateExportRequest = z.infer<typeof CreateExportRequestSchema>;

export const MissingMakeOrderStoreDtoSchema = z.object({
  storeNo: z.string(),
  storeName: z.string(),
  shippableLineCount: z.number(),
  orderNoticeNos: z.array(z.string()),
});
export type MissingMakeOrderStoreDto = z.infer<typeof MissingMakeOrderStoreDtoSchema>;

export const MakeOrderReadinessDtoSchema = z.object({
  batchId: z.string(),
  canExport: z.boolean(),
  shippableLineCount: z.number(),
  missingAddressCount: z.number(),
  missingStores: z.array(MissingMakeOrderStoreDtoSchema),
});
export type MakeOrderReadinessDto = z.infer<typeof MakeOrderReadinessDtoSchema>;

export const StoreAddressDtoSchema = z.object({
  id: z.string(),
  storeNo: z.string(),
  storeName: z.string(),
  receiver: z.string(),
  phone: z.string(),
  address: z.string(),
  isVip: z.boolean(),
  note: z.string(),
  sourceSheet: z.string(),
  sourceRow: z.number(),
  importedAt: z.string(),
  rawJson: z.string(),
  updatedByUserId: z.string().nullable().optional(),
  updatedByUsername: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StoreAddressDto = z.infer<typeof StoreAddressDtoSchema>;

export const UpsertStoreAddressRequestSchema = z.object({
  storeNo: z.string().default(""),
  storeName: z.string().min(1),
  receiver: z.string().min(1),
  phone: z.string().min(1),
  address: z.string().min(1),
  isVip: z.boolean().default(false),
  note: z.string().max(500).default(""),
});
export type UpsertStoreAddressRequest = z.infer<typeof UpsertStoreAddressRequestSchema>;

export const ImportStoreAddressesRequestSchema = z.object({
  fileName: z.string().min(1),
  contentBase64: z.string().min(1),
});
export type ImportStoreAddressesRequest = z.infer<typeof ImportStoreAddressesRequestSchema>;

export const StoreAddressImportPreviewItemSchema = z.object({
  action: z.enum(["create", "update", "unchanged"]),
  storeNo: z.string(),
  storeName: z.string(),
  receiver: z.string(),
  phone: z.string(),
  address: z.string(),
  isVip: z.boolean(),
  sourceSheet: z.string(),
  sourceRow: z.number(),
  existing: z
    .object({
      storeNo: z.string(),
      storeName: z.string(),
      receiver: z.string(),
      phone: z.string(),
      address: z.string(),
      isVip: z.boolean(),
    })
    .nullable(),
});
export type StoreAddressImportPreviewItem = z.infer<typeof StoreAddressImportPreviewItemSchema>;

export const ImportStoreAddressesPreviewResponseSchema = z.object({
  fileName: z.string(),
  sheetCount: z.number(),
  parsedRowCount: z.number(),
  skippedRowCount: z.number(),
  affectedStoreCount: z.number(),
  createCount: z.number(),
  updateCount: z.number(),
  unchangedCount: z.number(),
  items: z.array(StoreAddressImportPreviewItemSchema),
});
export type ImportStoreAddressesPreviewResponse = z.infer<typeof ImportStoreAddressesPreviewResponseSchema>;

export const ImportStoreAddressesResponseSchema = z.object({
  fileName: z.string(),
  sheetCount: z.number(),
  parsedRowCount: z.number(),
  importedAddressCount: z.number(),
  skippedRowCount: z.number(),
});
export type ImportStoreAddressesResponse = z.infer<typeof ImportStoreAddressesResponseSchema>;

export const CreateBatchRequestSchema = z.object({
  filePath: z.string().min(1),
  fileName: z.string().optional(),
  mode: z.enum(["mock", "test_api", "production_api"]).default("mock"),
});
export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>;

export const UploadOrderFileRequestSchema = z.object({
  fileName: z.string().min(1),
  contentBase64: z.string().min(1),
});
export type UploadOrderFileRequest = z.infer<typeof UploadOrderFileRequestSchema>;

export const UploadOrderFileResponseSchema = z.object({
  filePath: z.string(),
  fileName: z.string(),
});
export type UploadOrderFileResponse = z.infer<typeof UploadOrderFileResponseSchema>;

export const RunMockReviewRequestSchema = z.object({
  mockDataFile: z.string().min(1).default("examples/mock_flow_data.json"),
});
export type RunMockReviewRequest = z.infer<typeof RunMockReviewRequestSchema>;

export const RunRealReviewRequestSchema = z.object({
  allowStaleCache: z.boolean().default(false),
});
export type RunRealReviewRequest = z.infer<typeof RunRealReviewRequestSchema>;

export const WarehouseUsageSettingsDtoSchema = z.object({
  includeMainWarehouse: z.boolean(),
  includeNearExpiryWarehouse: z.boolean(),
  includeDefectWarehouse: z.boolean(),
  includeOtherWarehouses: z.boolean(),
  updatedAt: z.string(),
  updatedByUserId: z.string().nullable().optional(),
  updatedByUsername: z.string().nullable().optional(),
});
export type WarehouseUsageSettingsDto = z.infer<typeof WarehouseUsageSettingsDtoSchema>;

export const UpdateWarehouseUsageSettingsRequestSchema = z.object({
  includeMainWarehouse: z.boolean(),
  includeNearExpiryWarehouse: z.boolean(),
  includeDefectWarehouse: z.boolean(),
  includeOtherWarehouses: z.boolean(),
});
export type UpdateWarehouseUsageSettingsRequest = z.infer<typeof UpdateWarehouseUsageSettingsRequestSchema>;

export const BulkApproveResponseDtoSchema = z.object({
  batch: BatchSummarySchema,
  updatedCount: z.number(),
});
export type BulkApproveResponseDto = z.infer<typeof BulkApproveResponseDtoSchema>;

export const SubmitReviewResponseDtoSchema = z.object({
  batch: BatchSummarySchema,
  pendingCount: z.number(),
  shipCount: z.number(),
  doNotShipCount: z.number(),
});
export type SubmitReviewResponseDto = z.infer<typeof SubmitReviewResponseDtoSchema>;

export const WdtGoodsSyncModeSchema = z.enum(["full", "incremental"]);
export type WdtGoodsSyncMode = z.infer<typeof WdtGoodsSyncModeSchema>;

export const WdtGoodsSyncStatusSchema = z.enum(["running", "success", "failed"]);
export type WdtGoodsSyncStatus = z.infer<typeof WdtGoodsSyncStatusSchema>;

export const CreateWdtGoodsSyncRunRequestSchema = z.object({
  mode: WdtGoodsSyncModeSchema.default("incremental"),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  pageSize: z.number().int().positive().max(1000).optional(),
  maxRetries: z.number().int().positive().optional(),
  retryDelaysMs: z.array(z.number().int().nonnegative()).optional(),
});
export type CreateWdtGoodsSyncRunRequest = z.infer<typeof CreateWdtGoodsSyncRunRequestSchema>;

export const WdtGoodsSyncRunDtoSchema = z.object({
  id: z.string(),
  mode: WdtGoodsSyncModeSchema,
  status: WdtGoodsSyncStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  rangeStart: z.string(),
  rangeEnd: z.string(),
  windowCount: z.number(),
  pageCount: z.number(),
  fetchedCount: z.number(),
  upsertedCount: z.number(),
  errorMessage: z.string(),
});
export type WdtGoodsSyncRunDto = z.infer<typeof WdtGoodsSyncRunDtoSchema>;

export const WdtGoodsSpecSearchResultDtoSchema = z.object({
  id: z.string(),
  goodsNo: z.string(),
  goodsName: z.string(),
  specNo: z.string(),
  specName: z.string(),
  specCode: z.string(),
  barcode: z.string(),
  barcodes: z.array(z.string()),
  deleted: z.number(),
  modified: z.string(),
  syncedAt: z.string(),
});
export type WdtGoodsSpecSearchResultDto = z.infer<typeof WdtGoodsSpecSearchResultDtoSchema>;

export const ProductMappingStatusSchema = z.enum(["confirmed", "disabled", "needs_review"]);
export type ProductMappingStatus = z.infer<typeof ProductMappingStatusSchema>;

export const ProductMappingDtoSchema = z.object({
  id: z.string(),
  externalBarcode: z.string(),
  externalGoodsName: z.string(),
  externalGoodsCode: z.string(),
  wdtGoodsNo: z.string(),
  wdtGoodsName: z.string(),
  wdtSpecNo: z.string(),
  wdtSpecName: z.string(),
  wdtBarcode: z.string(),
  status: ProductMappingStatusSchema,
  sourceBatchId: z.string(),
  confirmedByUserId: z.string().nullable().optional(),
  confirmedAt: z.string(),
  note: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductMappingDto = z.infer<typeof ProductMappingDtoSchema>;

export const ProductMatchCandidateDtoSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  reviewLineId: z.string(),
  externalBarcode: z.string(),
  externalGoodsName: z.string(),
  externalGoodsCode: z.string(),
  wdtSpecNo: z.string(),
  wdtGoodsNo: z.string(),
  wdtGoodsName: z.string(),
  wdtSpecName: z.string(),
  wdtBarcode: z.string(),
  score: z.number(),
  basis: z.string(),
  source: z.string(),
  createdAt: z.string(),
});
export type ProductMatchCandidateDto = z.infer<typeof ProductMatchCandidateDtoSchema>;

export const ConfirmProductMappingRequestSchema = z.object({
  externalBarcode: z.string().default(""),
  externalGoodsName: z.string().default(""),
  externalGoodsCode: z.string().default(""),
  wdtSpecNo: z.string().min(1),
  sourceBatchId: z.string().default(""),
  note: z.string().max(500).default(""),
});
export type ConfirmProductMappingRequest = z.infer<typeof ConfirmProductMappingRequestSchema>;

export const UpdateProductMappingStatusRequestSchema = z.object({
  status: z.enum(["disabled", "needs_review"]),
  note: z.string().max(500).default(""),
});
export type UpdateProductMappingStatusRequest = z.infer<typeof UpdateProductMappingStatusRequestSchema>;

export const ExternalProductTypeSchema = z.enum(["normal", "sample", "bundle", "gift"]);
export type ExternalProductType = z.infer<typeof ExternalProductTypeSchema>;

export const ExternalProductStatusSchema = z.enum(["confirmed", "needs_review", "disabled"]);
export type ExternalProductStatus = z.infer<typeof ExternalProductStatusSchema>;

export const ExternalProductComponentRoleSchema = z.enum(["primary", "replacement", "extra"]);
export type ExternalProductComponentRole = z.infer<typeof ExternalProductComponentRoleSchema>;

export const ExternalProductComponentMatchStatusSchema = z.enum([
  "unique_wdt_hit",
  "no_wdt_hit",
  "ambiguous_wdt_hit",
  "deleted_only_wdt_hit",
  "needs_review",
]);
export type ExternalProductComponentMatchStatus = z.infer<typeof ExternalProductComponentMatchStatusSchema>;

export const ImportExternalProductsRequestSchema = z.object({
  fileName: z.string().min(1),
  contentBase64: z.string().min(1),
});
export type ImportExternalProductsRequest = z.infer<typeof ImportExternalProductsRequestSchema>;

export const ExternalProductComponentDtoSchema = z.object({
  id: z.string(),
  externalProductId: z.string(),
  sortOrder: z.number(),
  role: ExternalProductComponentRoleSchema,
  componentBarcode: z.string(),
  componentGoodsCode: z.string(),
  componentName: z.string(),
  componentSpec: z.string(),
  quantityMultiplier: z.number(),
  wdtSpecNo: z.string(),
  wdtGoodsNo: z.string(),
  wdtGoodsName: z.string(),
  wdtSpecName: z.string(),
  wdtBarcode: z.string(),
  matchStatus: ExternalProductComponentMatchStatusSchema,
  matchMessage: z.string(),
  note: z.string(),
  sourceSheet: z.string(),
  sourceRow: z.number(),
  rawJson: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExternalProductComponentDto = z.infer<typeof ExternalProductComponentDtoSchema>;

export const ExternalProductDtoSchema = z.object({
  id: z.string(),
  type: ExternalProductTypeSchema,
  externalBarcode: z.string(),
  externalGoodsCode: z.string(),
  externalGoodsName: z.string(),
  status: ExternalProductStatusSchema,
  sourceFileName: z.string(),
  sourceSheet: z.string(),
  sourceRow: z.number(),
  importedAt: z.string(),
  rawJson: z.string(),
  note: z.string(),
  updatedByUserId: z.string().nullable().optional(),
  updatedByUsername: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  components: z.array(ExternalProductComponentDtoSchema),
});
export type ExternalProductDto = z.infer<typeof ExternalProductDtoSchema>;

export const ExternalProductImportComponentPreviewSchema = z.object({
  role: ExternalProductComponentRoleSchema,
  componentBarcode: z.string(),
  componentGoodsCode: z.string(),
  componentName: z.string(),
  componentSpec: z.string(),
  quantityMultiplier: z.number(),
  wdtSpecNo: z.string(),
  wdtGoodsNo: z.string(),
  wdtGoodsName: z.string(),
  wdtSpecName: z.string(),
  wdtBarcode: z.string(),
  matchStatus: ExternalProductComponentMatchStatusSchema,
  matchMessage: z.string(),
  note: z.string(),
  sourceSheet: z.string(),
  sourceRow: z.number(),
  rawJson: z.string(),
});
export type ExternalProductImportComponentPreview = z.infer<typeof ExternalProductImportComponentPreviewSchema>;

export const ExternalProductImportPreviewItemSchema = z.object({
  action: z.enum(["create", "update", "unchanged"]),
  type: ExternalProductTypeSchema,
  externalBarcode: z.string(),
  externalGoodsCode: z.string(),
  externalGoodsName: z.string(),
  status: ExternalProductStatusSchema,
  sourceSheet: z.string(),
  sourceRow: z.number(),
  note: z.string(),
  rawJson: z.string(),
  componentCount: z.number(),
  resolvedComponentCount: z.number(),
  needsReviewComponentCount: z.number(),
  existing: z
    .object({
      id: z.string(),
      status: ExternalProductStatusSchema,
      componentCount: z.number(),
      updatedAt: z.string(),
    })
    .nullable(),
  components: z.array(ExternalProductImportComponentPreviewSchema),
});
export type ExternalProductImportPreviewItem = z.infer<typeof ExternalProductImportPreviewItemSchema>;

export const ImportExternalProductsPreviewResponseSchema = z.object({
  fileName: z.string(),
  sheetCount: z.number(),
  parsedProductCount: z.number(),
  parsedComponentCount: z.number(),
  skippedRowCount: z.number(),
  createCount: z.number(),
  updateCount: z.number(),
  unchangedCount: z.number(),
  needsReviewCount: z.number(),
  items: z.array(ExternalProductImportPreviewItemSchema),
});
export type ImportExternalProductsPreviewResponse = z.infer<typeof ImportExternalProductsPreviewResponseSchema>;

export const ImportExternalProductsResponseSchema = z.object({
  fileName: z.string(),
  sheetCount: z.number(),
  parsedProductCount: z.number(),
  parsedComponentCount: z.number(),
  importedProductCount: z.number(),
  importedComponentCount: z.number(),
  skippedRowCount: z.number(),
  needsReviewCount: z.number(),
});
export type ImportExternalProductsResponse = z.infer<typeof ImportExternalProductsResponseSchema>;
