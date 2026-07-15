import type { ReviewProductType, SharedComponentPriority } from "@jy-trade/shared";

export type AllocationWarehouseType = "main" | "near_expiry" | "defect" | "other";

export interface AllocationWarehouseStock {
  warehouseNo: string;
  warehouseName: string;
  availableStock: number;
  type: AllocationWarehouseType;
}

export interface AllocationComponent {
  specNo: string;
  quantityPerItem: number;
  warehouses: AllocationWarehouseStock[];
}

export interface SharedInventoryAllocationInput {
  id: string;
  productType: ReviewProductType;
  demandQty: number;
  vip: boolean;
  components: AllocationComponent[];
}

export interface SharedInventoryAllocation {
  quantity: number;
  warehouseNo: string;
  warehouseName: string;
}

interface MutableAllocation extends SharedInventoryAllocation {
  warehouseKey: string;
}

export function allocateSharedInventory(
  inputs: SharedInventoryAllocationInput[],
  priority: SharedComponentPriority,
): Map<string, SharedInventoryAllocation> {
  const remaining = initializeRemainingStock(inputs);
  const allocations = new Map<string, MutableAllocation>();
  const tiers = priority === "goods_first"
    ? [{ vip: true, productType: "goods" }, { vip: true, productType: "suite" }, { vip: false, productType: "goods" }, { vip: false, productType: "suite" }] as const
    : [{ vip: true, productType: "suite" }, { vip: true, productType: "goods" }, { vip: false, productType: "suite" }, { vip: false, productType: "goods" }] as const;

  for (const tier of tiers) {
    const rows = inputs.filter((input) => input.vip === tier.vip && input.productType === tier.productType);
    allocateTierFairly(rows, remaining, allocations);
  }

  return new Map([...allocations].map(([id, allocation]) => [id, {
    quantity: allocation.quantity,
    warehouseNo: allocation.warehouseNo,
    warehouseName: allocation.warehouseName,
  }]));
}

function allocateTierFairly(
  rows: SharedInventoryAllocationInput[],
  remaining: Map<string, number>,
  allocations: Map<string, MutableAllocation>,
) {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const row of rows) {
      const demand = Math.max(0, Math.floor(row.demandQty));
      const current = allocations.get(row.id);
      if (demand <= (current?.quantity ?? 0) || row.components.length === 0) continue;
      const warehouse = current
        ? warehouseCandidateForKey(row, current.warehouseKey, remaining)
        : selectWarehouse(row, demand, remaining);
      if (!warehouse || warehouse.buildable < 1) continue;
      consumeOne(row, warehouse.key, remaining);
      allocations.set(row.id, {
        quantity: (current?.quantity ?? 0) + 1,
        warehouseKey: warehouse.key,
        warehouseNo: warehouse.warehouseNo,
        warehouseName: warehouse.warehouseName,
      });
      progressed = true;
    }
  }
}

function initializeRemainingStock(inputs: SharedInventoryAllocationInput[]) {
  const remaining = new Map<string, number>();
  for (const input of inputs) {
    for (const component of input.components) {
      for (const warehouse of component.warehouses) {
        const key = stockKey(component.specNo, warehouseKey(warehouse));
        const available = Math.max(0, warehouse.availableStock);
        remaining.set(key, Math.max(remaining.get(key) ?? 0, available));
      }
    }
  }
  return remaining;
}

function selectWarehouse(input: SharedInventoryAllocationInput, demandQty: number, remaining: Map<string, number>) {
  const candidates = warehouseCandidates(input, remaining).filter((candidate) => candidate.buildable > 0);
  const satisfying = candidates.filter((candidate) => candidate.buildable >= demandQty).sort(compareWarehouseCandidates);
  if (satisfying.length > 0) return satisfying[0];
  return candidates.sort((left, right) => right.buildable - left.buildable || compareWarehouseCandidates(left, right))[0];
}

function warehouseCandidates(input: SharedInventoryAllocationInput, remaining: Map<string, number>) {
  const identities = new Map<string, AllocationWarehouseStock>();
  for (const component of input.components) {
    for (const warehouse of component.warehouses) identities.set(warehouseKey(warehouse), warehouse);
  }
  return [...identities].map(([key, warehouse]) => ({
    key,
    warehouseNo: warehouse.warehouseNo,
    warehouseName: warehouse.warehouseName,
    type: warehouse.type,
    buildable: buildableAtWarehouse(input, key, remaining),
  }));
}

function warehouseCandidateForKey(input: SharedInventoryAllocationInput, key: string, remaining: Map<string, number>) {
  return warehouseCandidates(input, remaining).find((candidate) => candidate.key === key);
}

function buildableAtWarehouse(input: SharedInventoryAllocationInput, key: string, remaining: Map<string, number>) {
  return input.components.reduce((capacity, component) => {
    const required = component.quantityPerItem;
    if (!Number.isFinite(required) || required <= 0) return 0;
    return Math.min(capacity, Math.floor(((remaining.get(stockKey(component.specNo, key)) ?? 0) + 1e-9) / required));
  }, Number.POSITIVE_INFINITY);
}

function consumeOne(input: SharedInventoryAllocationInput, warehouse: string, remaining: Map<string, number>) {
  for (const component of input.components) {
    const key = stockKey(component.specNo, warehouse);
    remaining.set(key, Math.max(0, (remaining.get(key) ?? 0) - component.quantityPerItem));
  }
}

function warehouseKey(warehouse: Pick<AllocationWarehouseStock, "warehouseNo" | "warehouseName">) {
  return `${warehouse.warehouseNo}\u0000${warehouse.warehouseName}`;
}

function stockKey(specNo: string, warehouse: string) {
  return `${specNo}\u0001${warehouse}`;
}

function compareWarehouseCandidates(
  left: { type: AllocationWarehouseType; warehouseNo: string; warehouseName: string },
  right: { type: AllocationWarehouseType; warehouseNo: string; warehouseName: string },
) {
  const rank: Record<AllocationWarehouseType, number> = { main: 0, near_expiry: 1, defect: 2, other: 3 };
  return rank[left.type] - rank[right.type]
    || left.warehouseNo.localeCompare(right.warehouseNo)
    || left.warehouseName.localeCompare(right.warehouseName);
}
