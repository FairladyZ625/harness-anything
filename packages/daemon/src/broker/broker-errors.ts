export class BrokerSubmitPreflightError extends Error {
  readonly path: string;
  readonly status: string;

  constructor(pathName: string, status: string, message: string) {
    super(`${message}: ${pathName} (${status})`);
    this.name = "BrokerSubmitPreflightError";
    this.path = pathName;
    this.status = status;
  }
}

export class BrokerReplicaIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerReplicaIntegrityError";
  }
}
