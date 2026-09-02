export class DistributedPromotionGatewayError extends Error {
  readonly code = "DISTRIBUTED_PROMOTION_GATEWAY_UNAVAILABLE";

  constructor() {
    super("Distributed promotion gateway is unavailable.");
    this.name = "DistributedPromotionGatewayError";
  }
}

export class DistributedPromotionGatewayResponseError extends Error {
  readonly code = "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID";

  constructor() {
    super("Distributed promotion gateway response is invalid.");
    this.name = "DistributedPromotionGatewayResponseError";
  }
}

export class DistributedPromotionGatewayAbortedError extends Error {
  readonly code = "DISTRIBUTED_PROMOTION_GATEWAY_ABORTED";

  constructor() {
    super("Distributed promotion gateway request was aborted.");
    this.name = "DistributedPromotionGatewayAbortedError";
  }
}
