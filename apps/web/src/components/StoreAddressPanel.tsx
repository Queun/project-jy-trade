import { useEffect, useState } from "react";
import { Check, MapPin, Plus, Search, Save, Trash2, Upload, X } from "lucide-react";
import type { ClearStoreAddressesResponse, ImportStoreAddressesPreviewResponse, ImportStoreAddressesResponse, MissingMakeOrderStoreDto, StoreAddressDto, UpsertStoreAddressRequest } from "@jy-trade/shared";

import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";

interface StoreAddressPanelProps {
  canEdit: boolean;
  focusMissingStore?: MissingMakeOrderStoreDto | null;
  focusMissingStoreRequestId?: number;
  missingStores: MissingMakeOrderStoreDto[];
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  onSaved: () => void;
}

const emptyDraft: UpsertStoreAddressRequest = {
  storeNo: "",
  storeName: "",
  receiver: "",
  phone: "",
  address: "",
  isVip: false,
  note: "",
};

export function StoreAddressPanel({
  canEdit,
  focusMissingStore,
  focusMissingStoreRequestId = 0,
  missingStores,
  onMessage,
  onError,
  onSaved,
}: StoreAddressPanelProps) {
  const [query, setQuery] = useState("");
  const [addresses, setAddresses] = useState<StoreAddressDto[]>([]);
  const [draft, setDraft] = useState<UpsertStoreAddressRequest>(emptyDraft);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [importDraft, setImportDraft] = useState<{ fileName: string; contentBase64: string } | null>(null);
  const [importPreview, setImportPreview] = useState<ImportStoreAddressesPreviewResponse | null>(null);

  function reportError(message: string) {
    setError(message);
    onError(message);
  }

  async function refreshAddresses(nextQuery = query) {
    const response = await fetch(`/api/v1/store-addresses?query=${encodeURIComponent(nextQuery)}`);
    if (!response.ok) {
      setAddresses([]);
      return;
    }
    setAddresses((await response.json()) as StoreAddressDto[]);
  }

  async function saveAddress() {
    setError("");
    const response = await fetch("/api/v1/store-addresses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!response.ok) {
      const body = await response.json();
      reportError(body.message ?? "门店地址保存失败");
      return;
    }
    const saved = (await response.json()) as StoreAddressDto;
    setQuery(saved.storeNo || saved.storeName);
    setDraft({ ...emptyDraft, storeNo: saved.storeNo, storeName: saved.storeName });
    setEditingAddressId(saved.id);
    await refreshAddresses(saved.storeNo || saved.storeName);
    onSaved();
    onMessage("门店地址已保存");
  }

  async function importWorkbook(file: File) {
    setError("");
    setImporting(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const nextImportDraft = { fileName: file.name, contentBase64 };
      const response = await fetch("/api/v1/store-addresses/import-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextImportDraft),
      });
      if (!response.ok) {
        const body = await response.json();
        reportError(body.message ?? "地址 Excel 解析失败");
        return;
      }
      const preview = (await response.json()) as ImportStoreAddressesPreviewResponse;
      setImportDraft(nextImportDraft);
      setImportPreview(preview);
      onMessage(`已解析 ${preview.parsedRowCount} 条地址，新增 ${preview.createCount} 个，更新 ${preview.updateCount} 个`);
    } catch (error) {
      reportError(error instanceof Error ? error.message : "地址 Excel 解析失败");
    } finally {
      setImporting(false);
    }
  }

  async function confirmImportWorkbook() {
    if (!importDraft || !importPreview) return;
    setError("");
    setImporting(true);
    try {
      const response = await fetch("/api/v1/store-addresses/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(importDraft),
      });
      if (!response.ok) {
        const body = await response.json();
        reportError(body.message ?? "地址 Excel 导入失败");
        return;
      }
      const result = (await response.json()) as ImportStoreAddressesResponse;
      setQuery("");
      await refreshAddresses("");
      setImportDraft(null);
      setImportPreview(null);
      onSaved();
      onMessage(`已确认导入 ${result.importedAddressCount} 条来源记录，新增 ${importPreview.createCount} 个，更新 ${importPreview.updateCount} 个`);
    } catch (error) {
      reportError(error instanceof Error ? error.message : "地址 Excel 导入失败");
    } finally {
      setImporting(false);
    }
  }

  async function clearAddresses() {
    const confirmed = window.confirm("确定清空当前地址库吗？清空后做单会暂时缺少收货地址；VIP 门店优先标记会保留。请在清空后重新导入最新地址表。");
    if (!confirmed) return;
    setError("");
    setClearing(true);
    try {
      const response = await fetch("/api/v1/store-addresses", { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json();
        reportError(body.message ?? "地址库清空失败");
        return;
      }
      const result = (await response.json()) as ClearStoreAddressesResponse;
      setQuery("");
      setDraft(emptyDraft);
      setEditingAddressId(null);
      setImportDraft(null);
      setImportPreview(null);
      await refreshAddresses("");
      onSaved();
      onMessage(`已清空 ${result.clearedCount} 条旧地址，保留 ${result.preservedVipCount} 个 VIP 门店标记，请重新导入最新地址表`);
    } catch (error) {
      reportError(error instanceof Error ? error.message : "地址库清空失败");
    } finally {
      setClearing(false);
    }
  }

  function useMissingStore(store: MissingMakeOrderStoreDto) {
    setDraft((current) => ({ ...current, storeNo: store.storeNo, storeName: store.storeName }));
    setEditingAddressId(null);
    setQuery(store.storeNo || store.storeName);
  }

  function editAddress(address: StoreAddressDto) {
    setEditingAddressId(address.id);
    setDraft({
      storeNo: address.storeNo,
      storeName: address.storeName,
      receiver: address.receiver,
      phone: address.phone,
      address: address.address,
      isVip: address.isVip,
      note: address.note,
    });
  }

  function startNewAddress() {
    setDraft(emptyDraft);
    setEditingAddressId(null);
    setError("");
  }

  useEffect(() => {
    void refreshAddresses();
  }, []);

  useEffect(() => {
    if (!focusMissingStore) return;
    useMissingStore(focusMissingStore);
    setError("");
  }, [focusMissingStoreRequestId]);

  const canSave = canEdit && draft.storeName.trim() && draft.receiver.trim() && draft.phone.trim() && draft.address.trim();
  const hasImportChanges = Boolean(importPreview && (importPreview.createCount > 0 || importPreview.updateCount > 0));

  return (
    <section className="mt-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">门店地址维护</h3>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">做单地址从这里读取，优先按门店编码匹配，未命中时再按门店名称匹配。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            aria-label="清空地址库"
            className="h-8 border border-rose-200 bg-background px-2 text-rose-700 hover:bg-rose-50"
            disabled={!canEdit || importing || clearing}
            onClick={() => void clearAddresses()}
          >
            <Trash2 className="h-4 w-4" />
            {clearing ? "清空中" : "清空地址库"}
          </Button>
          <label className={`inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border px-2 text-sm ${canEdit ? "cursor-pointer bg-background hover:bg-muted" : "cursor-not-allowed bg-muted text-muted-foreground"}`}>
            <Upload className="h-4 w-4" />
            {importing ? "处理中" : "导入地址 Excel"}
            <input
              className="sr-only"
              disabled={!canEdit || importing}
              type="file"
              accept=".xls,.xlsx"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importWorkbook(file);
              }}
            />
          </label>
          <Badge tone={canEdit ? "info" : "neutral"}>{canEdit ? "可编辑" : "只读"}</Badge>
        </div>
      </div>

      {missingStores.length > 0 ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50/60 p-3">
          <div className="text-sm font-medium text-amber-950">缺地址门店</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {missingStores.slice(0, 8).map((store) => (
              <button
                key={`${store.storeNo}-${store.storeName}`}
                className="rounded-md border border-amber-200 bg-background px-2 py-1 text-sm hover:bg-amber-100"
                type="button"
                onClick={() => useMissingStore(store)}
              >
                {store.storeName || store.storeNo}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {importPreview ? (
        <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium">地址导入预览</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {importPreview.fileName} / {importPreview.sheetCount} 个工作表 / {importPreview.parsedRowCount} 条来源记录
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="good">新增 {importPreview.createCount}</Badge>
              <Badge tone="info">更新 {importPreview.updateCount}</Badge>
              <Badge tone="neutral">不变 {importPreview.unchangedCount}</Badge>
            </div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {importPreview.items.filter((item) => item.action !== "unchanged").slice(0, 6).map((item) => (
              <div key={`${item.action}-${item.storeNo}-${item.storeName}-${item.sourceSheet}-${item.sourceRow}`} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{item.storeName || item.storeNo}</span>
                  <Badge tone={item.action === "create" ? "good" : "info"}>{item.action === "create" ? "新增" : "更新"}</Badge>
                </div>
                <div className="mt-1 text-muted-foreground">{item.receiver || "-"} / {item.phone || "-"}</div>
                <div className="mt-1 line-clamp-2 text-muted-foreground">{item.address}</div>
                {item.action === "update" && item.existing ? (
                  <div className="mt-2 rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                    原：{item.existing.receiver || "-"} / {item.existing.phone || "-"}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {importPreview.items.filter((item) => item.action !== "unchanged").length > 6 ? (
            <div className="mt-2 text-sm text-muted-foreground">还有 {importPreview.items.filter((item) => item.action !== "unchanged").length - 6} 个变更未展示</div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button disabled={!canEdit || importing || !hasImportChanges} onClick={() => void confirmImportWorkbook()}>
              <Check className="h-4 w-4" />
              确认更新地址
            </Button>
            <Button className="bg-muted text-muted-foreground hover:bg-muted/80" disabled={importing} onClick={() => { setImportDraft(null); setImportPreview(null); }}>
              <X className="h-4 w-4" />
              取消
            </Button>
            {!hasImportChanges ? <span className="text-sm text-muted-foreground">没有需要更新的地址。</span> : null}
          </div>
        </div>
      ) : null}

      <div className="mt-4 grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <input
              aria-label="门店地址查询"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              placeholder="门店编码、门店名称、收货人、电话或地址"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button className="h-9" onClick={() => void refreshAddresses()}>
              <Search className="h-4 w-4" />
              查询
            </Button>
          </div>
          <div className="mt-3 max-w-full overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">门店</th>
                  <th className="px-3 py-2 text-left font-medium">收货信息</th>
                  <th className="px-3 py-2 text-left font-medium">来源</th>
                  <th className="w-28 px-3 py-2 text-left font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {addresses.map((address) => (
                  <tr
                    key={address.id}
                    className={address.id === editingAddressId ? "border-t border-primary/30 bg-emerald-50/70" : "border-t border-border"}
                  >
                    <td className="px-3 py-3 align-top">
                      <div className="font-medium">{address.storeName}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
                        <span>{address.storeNo || "无门店编码"}</span>
                        {address.isVip ? <Badge tone="warn">VIP</Badge> : null}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div>{address.receiver} / {address.phone}</div>
                      <div className="mt-1 text-muted-foreground">{address.address}</div>
                    </td>
                    <td className="px-3 py-3 align-top text-muted-foreground">
                      <div>{address.sourceSheet || "手工维护"}</div>
                      {address.sourceRow ? <div className="mt-1">第 {address.sourceRow} 行</div> : null}
                      <div className="mt-1">{formatShortDate(address.updatedAt)}</div>
                    </td>
                    <td className="w-28 px-3 py-3 align-top">
                      <div className="flex flex-row flex-nowrap items-center gap-2 whitespace-nowrap">
                        <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" disabled={!canEdit} onClick={() => editAddress(address)}>
                          编辑
                        </Button>
                        {address.id === editingAddressId ? <Badge tone="info">编辑中</Badge> : null}
                      </div>
                    </td>
                  </tr>
                ))}
                {addresses.length === 0 ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-muted-foreground" colSpan={4}>
                      暂无门店地址
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">{editingAddressId ? "编辑地址" : "新建地址"}</h4>
            <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" disabled={!canEdit} onClick={startNewAddress}>
              <Plus className="h-4 w-4" />
              新建地址
            </Button>
          </div>
          {focusMissingStore ? (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1.5 text-xs text-amber-950">
              已带入缺地址门店；如果确定单里的门店编码或名称有误，可以在保存前直接修正。
            </div>
          ) : null}
          <div className="mt-3 grid gap-2">
            <Field label="门店编码" value={draft.storeNo} onChange={(value) => setDraft((current) => ({ ...current, storeNo: value }))} />
            <Field label="门店名称" value={draft.storeName} onChange={(value) => setDraft((current) => ({ ...current, storeName: value }))} />
            <Field label="收件人" value={draft.receiver} onChange={(value) => setDraft((current) => ({ ...current, receiver: value }))} />
            <Field label="手机" value={draft.phone} onChange={(value) => setDraft((current) => ({ ...current, phone: value }))} />
            <label>
              <span className="text-xs text-muted-foreground">地址</span>
              <textarea
                aria-label="地址"
                className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={draft.address}
                onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))}
              />
            </label>
            <label className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
              <input
                aria-label="VIP门店"
                checked={draft.isVip}
                className="h-4 w-4"
                disabled={!canEdit}
                type="checkbox"
                onChange={(event) => setDraft((current) => ({ ...current, isVip: event.target.checked }))}
              />
              VIP 门店优先分货
            </label>
            <Field label="备注" value={draft.note ?? ""} onChange={(value) => setDraft((current) => ({ ...current, note: value }))} />
          </div>
          {error ? <div className="mt-3 text-sm text-rose-700">{error}</div> : null}
          <Button className="mt-3" disabled={!canSave} onClick={() => void saveAddress()}>
            <Save className="h-4 w-4" />
            保存地址
          </Button>
          {!canEdit ? <div className="mt-3 text-sm text-muted-foreground">当前账号只能查看门店地址。</div> : null}
        </div>
      </div>
    </section>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        aria-label={label}
        className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function formatShortDate(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}
