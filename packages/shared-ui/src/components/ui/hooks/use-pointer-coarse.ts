import { useMediaQuery } from "./use-media-query.js";

export const POINTER_COARSE_QUERY =
  "(any-pointer: coarse) and not (any-pointer: fine)";

export function usePointerCoarse(): boolean {
  return useMediaQuery(POINTER_COARSE_QUERY);
}
