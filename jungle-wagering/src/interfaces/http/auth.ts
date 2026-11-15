import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

/**
 * AUTHENTICATION IS A DECLARED EXTENSION POINT, NOT AN IMPLEMENTATION (README section 2: it is worth no points
 * and must not compete with financial correctness). See ARCHITECTURE.md > "Authentication" for the design that
 * would be adopted: an external OIDC Identity Provider (Keycloak or Zitadel), bearer JWTs verified against its JWKS,
 * the `azp`/client id mapped to a providerId and enforced against `providerId` in every payload.
 *
 * Nothing here stores users or passwords.
 */
export interface ProviderIdentity {
  providerId: string;
}

/** Port: resolves who is calling. Swap the implementation to plug an IdP in; nothing else changes. */
export interface ProviderIdentityPort {
  resolve(request: unknown): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

/** Default adapter: no authentication. Returns no identity, which the guard below accepts. */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity | undefined> {
    return undefined;
  }
}

/**
 * Guard applied to the wagering/wallet endpoints (never to /health/*, which stay open by requirement).
 * No-op today: any identity (or none) is accepted. With a real adapter, return false/throw here to reject, and
 * compare `identity.providerId` with the `providerId` of the payload.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.identity.resolve(context.switchToHttp().getRequest());
    return true;
  }
}
