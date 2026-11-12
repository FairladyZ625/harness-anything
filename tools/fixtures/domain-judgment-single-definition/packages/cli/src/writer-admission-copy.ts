export function writerPermitted(active, token) {
  return token.generation === active.generation && token.ownerId === active.ownerId;
}
