/** Tipos de las respuestas de la API que usa la app del cliente. */
import type { OperationalStatus, PartStatus, PaymentStatus } from '@pasamanos/shared';

export interface OptionGroup {
  id: string; name: string; min: number; max: number;
  options: { id: string; name: string; priceDeltaCents: number; available: boolean }[];
}

export interface Product {
  id: string; name: string; description: string | null; ingredients: string | null; imageUrl: string | null;
  priceCents: number; prepMinutes: number; available: boolean; kind: 'simple' | 'combo'; groups: OptionGroup[];
}

export interface Menu {
  menuId: string; eventId: string | null; paused: boolean; pauseMessage: string | null;
  limits: { maxTotalCents: number; maxIndividualItems: number; maxCombos: number };
  categories: { id: string; name: string; paused: boolean; products: Product[] }[];
}

export interface User { id: string; name: string; isPlatformAdmin: boolean }

export interface PickupCredentials { token: string; shortCode: string; used: boolean }
export interface OrderPart { id: string; status: PartStatus; pickupPoint: string | null; pickup: PickupCredentials | null }

export interface OrderView {
  id: string; number: number; status: OperationalStatus; paymentStatus: PaymentStatus;
  totalCents: number; estimatedReadyAt: string | null; cancelReason: string | null; originName: string | null;
  parts: OrderPart[];
}

export interface CreatedOrder { orderId: string; orderNumber: number; totalCents: number; replayed: boolean }

export interface OrderRequest {
  paymentMethod: 'card_online' | 'payment_app';
  originLocationId?: string | null;
  items: { productId: string; quantity: number; selections: Record<string, string[]> }[];
}

export interface AppNotification { id: string; title?: string; body?: string; readAt?: string | null; createdAt?: string }
