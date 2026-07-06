import { useEffect, useState } from "react";
import { MapPin, Search, Save } from "lucide-react";
import type { MissingMakeOrderStoreDto, StoreAddressDto, UpsertStoreAddressRequest } from "@jy-trade/shared";

import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";

interface StoreAddressPanelProps {
  canEdit: boolean;
  missingStores: MissingMakeOrderStoreDto[];
  onMessage: (message: string) => void;
  onSaved: () => void;
}

const emptyDraft: UpsertStoreAddressRequest = {
  storeNo: "",
  storeName: "",
  receiver: "",
  phone: "",
  address: "",
  note: "",
};

export function StoreAddressPanel({ canEdit, missingStores, onMessage, onSaved }: StoreAddressPanelProps) {
  const [query, setQuery] = useState("");
  const [addresses, setAddresses] = useState<StoreAddressDto[]>([]);
  const [draft, setDraft] = useState<UpsertStoreAddressRequest>(emptyDraft);
  const [error, setError] = useState("");

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
      setError(body.message ?? "门店地址保存失败");
      return;
    }
    const saved = (await response.json()) as StoreAddressDto;
    setQuery(saved.storeNo || saved.storeName);
    setDraft({ ...emptyDraft, storeNo: saved.storeNo, storeName: saved.storeName });
    await refreshAddresses(saved.storeNo || saved.storeName);
    onSaved();
    onMessage("门店地址已保存");
  }

  function useMissingStore(store: MissingMakeOrderStoreDto) {
    setDraft((current) => ({ ...current, storeNo: store.storeNo, storeName: store.storeName }));
    setQuery(store.storeNo || store.storeName);
  }

  function editAddress(address: StoreAddressDto) {
    setDraft({
      storeNo: address.storeNo,
      storeName: address.storeName,
      receiver: address.receiver,
      phone: address.phone,
      address: address.address,
      note: address.note,
    });
  }

  useEffect(() => {
    void refreshAddresses();
  }, []);

  const canSave = canEdit && draft.storeName.trim() && draft.receiver.trim() && draft.phone.trim() && draft.address.trim();

  return (
    <section className="mt-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">门店地址维护</h3>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">系统维护地址会优先用于做单，未维护时再读取地址匹配表。</p>
        </div>
        <Badge tone={canEdit ? "info" : "neutral"}>{canEdit ? "可编辑" : "只读"}</Badge>
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
                  <th className="px-3 py-2 text-left font-medium">更新时间</th>
                  <th className="px-3 py-2 text-left font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {addresses.map((address) => (
                  <tr key={address.id} className="border-t border-border">
                    <td className="px-3 py-3 align-top">
                      <div className="font-medium">{address.storeName}</div>
                      <div className="mt-1 text-muted-foreground">{address.storeNo || "无门店编码"}</div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div>{address.receiver} / {address.phone}</div>
                      <div className="mt-1 text-muted-foreground">{address.address}</div>
                    </td>
                    <td className="px-3 py-3 align-top text-muted-foreground">{formatShortDate(address.updatedAt)}</td>
                    <td className="px-3 py-3 align-top">
                      <Button className="h-8 bg-muted px-2 text-muted-foreground hover:bg-muted/80" disabled={!canEdit} onClick={() => editAddress(address)}>
                        编辑
                      </Button>
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
          <h4 className="text-sm font-semibold">保存地址</h4>
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
