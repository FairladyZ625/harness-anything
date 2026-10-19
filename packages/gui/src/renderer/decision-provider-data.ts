import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  decisionProviderClient,
  type DecisionProviderCreateInput,
  type DecisionProviderUpdateInput,
} from "./decision-provider-client.ts";

export const decisionProviderQueryKey = ["decision-providers"] as const;

export function useDecisionProviderCatalog() {
  return useQuery({
    queryKey: decisionProviderQueryKey,
    queryFn: () => decisionProviderClient.list(),
    staleTime: 5_000,
  });
}

export function useDecisionProviderMutations() {
  const queryClient = useQueryClient(),
    refresh = () => queryClient.invalidateQueries({ queryKey: decisionProviderQueryKey });
  const create = useMutation({
      mutationFn: (input: DecisionProviderCreateInput) => decisionProviderClient.create(input),
      onSuccess: refresh,
    }),
    update = useMutation({
      mutationFn: (input: DecisionProviderUpdateInput) => decisionProviderClient.update(input),
      onSuccess: refresh,
    }),
    probe = useMutation({
      mutationFn: (providerId: string) => decisionProviderClient.probe(providerId),
      onSuccess: refresh,
    }),
    remove = useMutation({
      mutationFn: (providerId: string) => decisionProviderClient.delete(providerId),
      onSuccess: refresh,
    });
  return {
    create,
    update,
    probe,
    remove,
    busy: create.isPending || update.isPending || probe.isPending || remove.isPending,
  };
}
