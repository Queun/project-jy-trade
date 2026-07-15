import { describe, expect, it } from "vitest";

import { allocateSharedInventory, type AllocationComponent, type SharedInventoryAllocationInput } from "./reviewAllocator.js";

const warehouse = (specNo: string, availableStock: number, quantityPerItem = 1): AllocationComponent => ({
  specNo,
  quantityPerItem,
  warehouses: [{ warehouseNo: "001", warehouseName: "主仓", type: "main", availableStock }],
});

describe("shared component review allocation", () => {
  it("allocates suites before goods while preserving VIP priority", () => {
    const inputs: SharedInventoryAllocationInput[] = [
      { id: "regular-suite", productType: "suite", demandQty: 5, vip: false, components: [warehouse("A", 6)] },
      { id: "vip-goods", productType: "goods", demandQty: 4, vip: true, components: [warehouse("A", 6)] },
      { id: "regular-goods", productType: "goods", demandQty: 5, vip: false, components: [warehouse("A", 6)] },
    ];

    expect(Object.fromEntries(allocateSharedInventory(inputs, "suite_first"))).toEqual({
      "vip-goods": { quantity: 4, warehouseNo: "001", warehouseName: "主仓" },
      "regular-suite": { quantity: 2, warehouseNo: "001", warehouseName: "主仓" },
    });
  });

  it("switches product priority only inside each VIP tier", () => {
    const inputs: SharedInventoryAllocationInput[] = [
      { id: "vip-suite", productType: "suite", demandQty: 2, vip: true, components: [warehouse("A", 5)] },
      { id: "vip-goods", productType: "goods", demandQty: 2, vip: true, components: [warehouse("A", 5)] },
      { id: "regular-suite", productType: "suite", demandQty: 2, vip: false, components: [warehouse("A", 5)] },
      { id: "regular-goods", productType: "goods", demandQty: 2, vip: false, components: [warehouse("A", 5)] },
    ];

    expect(Object.fromEntries(allocateSharedInventory(inputs, "goods_first"))).toEqual({
      "vip-goods": { quantity: 2, warehouseNo: "001", warehouseName: "主仓" },
      "vip-suite": { quantity: 2, warehouseNo: "001", warehouseName: "主仓" },
      "regular-goods": { quantity: 1, warehouseNo: "001", warehouseName: "主仓" },
    });
  });

  it("shares a component fairly across different suites in the same tier", () => {
    const inputs: SharedInventoryAllocationInput[] = [
      { id: "suite-a-1", productType: "suite", demandQty: 4, vip: false, components: [warehouse("SHARED", 6), warehouse("A", 20)] },
      { id: "suite-a-2", productType: "suite", demandQty: 4, vip: false, components: [warehouse("SHARED", 6), warehouse("A", 20)] },
      { id: "suite-b-1", productType: "suite", demandQty: 4, vip: false, components: [warehouse("SHARED", 6), warehouse("B", 20)] },
      { id: "suite-b-2", productType: "suite", demandQty: 4, vip: false, components: [warehouse("SHARED", 6), warehouse("B", 20)] },
    ];

    expect([...allocateSharedInventory(inputs, "suite_first").values()].map((item) => item.quantity)).toEqual([2, 2, 1, 1]);
  });

  it("requires every suite component in the same warehouse and consumes all components", () => {
    const inputs: SharedInventoryAllocationInput[] = [
      { id: "suite", productType: "suite", demandQty: 10, vip: false, components: [warehouse("A", 10, 2), warehouse("B", 4)] },
      { id: "goods-b", productType: "goods", demandQty: 10, vip: false, components: [warehouse("B", 4)] },
    ];

    expect(Object.fromEntries(allocateSharedInventory(inputs, "suite_first"))).toEqual({
      suite: { quantity: 4, warehouseNo: "001", warehouseName: "主仓" },
    });
  });
});
