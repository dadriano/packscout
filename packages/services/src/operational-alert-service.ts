import type {
  AdminAlertDetail,
  AdminAlertState,
  AdminAlertSummary,
} from "@packscout/contracts";
import type {
  ProviderActor,
  ProviderActorKeyer,
  ProviderClock,
} from "./provider-configuration-service.ts";

export interface OperationalAlertRepository {
  listAlerts(input: {
    organizationId: string;
    state?: AdminAlertState;
    limit: number;
  }): Promise<readonly AdminAlertSummary[]>;
  getAlert(
    organizationId: string,
    alertId: string,
  ): Promise<AdminAlertDetail | null>;
  acknowledge(input: {
    organizationId: string;
    alertId: string;
    actorKey: string;
    acknowledgedAt: Date;
  }): Promise<AdminAlertSummary | null>;
  resolve(input: {
    organizationId: string;
    alertId: string;
    actorKey: string;
    resolvedAt: Date;
  }): Promise<AdminAlertSummary | null>;
}

export class OperationalAlertServiceError extends Error {
  constructor(
    readonly code: "ALERT_NOT_FOUND" | "FORBIDDEN" | "INVALID_ALERT_REQUEST",
    readonly status: number,
  ) {
    super(
      code === "ALERT_NOT_FOUND"
        ? "Operational alert not found."
        : code === "FORBIDDEN"
          ? "You do not have permission to access operational alerts."
          : "Operational alert request is invalid.",
    );
    this.name = "OperationalAlertServiceError";
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class OperationalAlertService {
  constructor(
    private readonly repository: OperationalAlertRepository,
    private readonly keyer: ProviderActorKeyer,
    private readonly clock: ProviderClock,
  ) {}

  list(
    actor: ProviderActor,
    input: { state?: AdminAlertState; limit?: number },
  ): Promise<readonly AdminAlertSummary[]> {
    this.authorize(actor);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new OperationalAlertServiceError("INVALID_ALERT_REQUEST", 422);
    }
    return this.repository.listAlerts({
      organizationId: actor.organizationId,
      state: input.state,
      limit,
    });
  }

  async detail(actor: ProviderActor, alertId: string): Promise<AdminAlertDetail> {
    this.authorize(actor);
    this.assertId(alertId);
    const alert = await this.repository.getAlert(actor.organizationId, alertId);
    if (!alert) throw new OperationalAlertServiceError("ALERT_NOT_FOUND", 404);
    return alert;
  }

  async acknowledge(
    actor: ProviderActor,
    alertId: string,
  ): Promise<AdminAlertSummary> {
    this.authorize(actor);
    this.assertId(alertId);
    const current = await this.repository.getAlert(actor.organizationId, alertId);
    if (!current) throw new OperationalAlertServiceError("ALERT_NOT_FOUND", 404);
    if (current.state === "resolved") return current;
    const alert = await this.repository.acknowledge({
      organizationId: actor.organizationId,
      alertId,
      actorKey: this.keyer.keyFor({
        organizationId: actor.organizationId,
        operatorId: actor.operatorId,
      }),
      acknowledgedAt: this.clock.now(),
    });
    if (!alert) throw new OperationalAlertServiceError("ALERT_NOT_FOUND", 404);
    return alert;
  }

  async resolve(
    actor: ProviderActor,
    alertId: string,
  ): Promise<AdminAlertSummary> {
    this.authorize(actor);
    this.assertId(alertId);
    const alert = await this.repository.resolve({
      organizationId: actor.organizationId,
      alertId,
      actorKey: this.keyer.keyFor({
        organizationId: actor.organizationId,
        operatorId: actor.operatorId,
      }),
      resolvedAt: this.clock.now(),
    });
    if (!alert) throw new OperationalAlertServiceError("ALERT_NOT_FOUND", 404);
    return alert;
  }

  private authorize(actor: ProviderActor): void {
    if (actor.role !== "admin" && actor.role !== "data_operator") {
      throw new OperationalAlertServiceError("FORBIDDEN", 403);
    }
  }

  private assertId(alertId: string): void {
    if (!uuidPattern.test(alertId)) {
      throw new OperationalAlertServiceError("INVALID_ALERT_REQUEST", 422);
    }
  }
}
