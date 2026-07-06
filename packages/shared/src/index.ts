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
  externalBarcode: z.string(),
  externalGoodsName: z.string(),
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
