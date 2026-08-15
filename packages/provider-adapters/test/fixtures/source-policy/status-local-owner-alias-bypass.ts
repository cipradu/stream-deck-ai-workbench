import { Logger as LocalLogger, ManagedRuntime as LocalRuntime, Schedule as LocalSchedule } from "effect";
import * as EffectOwners from "effect";

import {
  Logger as BarrelLogger,
  ManagedRuntime as BarrelRuntime,
  Schedule as BarrelSchedule,
} from "./status-local-owner-barrel.js";

export const aliasedStatusOwners = {
  directRuntime: LocalRuntime,
  directSchedule: LocalSchedule,
  directLogger: LocalLogger,
  namespaceRuntime: EffectOwners.ManagedRuntime,
  namespaceSchedule: EffectOwners.Schedule,
  namespaceLogger: EffectOwners.Logger,
  computedRuntime: EffectOwners["ManagedRuntime"],
  computedSchedule: EffectOwners["Schedule"],
  computedLogger: EffectOwners["Logger"],
  barrelRuntime: BarrelRuntime,
  barrelSchedule: BarrelSchedule,
  barrelLogger: BarrelLogger,
};
