import { ReviewService } from "./ReviewService.server";
import type { ReviewServiceDependencies } from "./ReviewService.server";

/**
 * Process-wide singleton behind the plugin's RPC surface. Method signatures
 * correspond one-to-one with the legacy exported functions they replaced;
 * dependencies (state store path, git runner, diff parser, mutexes) are
 * injectable via the ReviewService constructor for tests.
 */
export const reviewService = new ReviewService();
const MAINTENANCE_INTERVAL_MS = 60_000;
const stopMaintenance = reviewService.startMaintenance(MAINTENANCE_INTERVAL_MS);
process.once("beforeExit", stopMaintenance);

export { ReviewService };
export type { ReviewServiceDependencies };
