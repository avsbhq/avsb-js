import { NgModule, makeEnvironmentProviders } from '@angular/core'
import type {
  EnvironmentProviders,
  ModuleWithProviders,
  Provider,
} from '@angular/core'
import { AvsbClient } from '@avsbhq/browser'
import { AVSB_CLIENT, AVSB_CONFIG } from './avsb.tokens'
import { AvsbService } from './avsb.service'
import { AvsbFlagDirective } from './flag.directive'
import { AvsbExposureDirective } from './exposure.directive'
import { AvsbFlagPipe } from './pipes/avsb-flag.pipe'
import { AvsbFlagStatePipe } from './pipes/avsb-flag-state.pipe'
import type { AvsbConfig } from './types'
import type { AngularAvsbClient } from './clientInterface'
import { SDK_TYPE, SDK_VERSION } from './version'

/**
 * Everything this package contributes to a template. Import it into a
 * standalone component, or into an NgModule alongside `AvsbModule`.
 *
 * ```ts
 * @Component({ standalone: true, imports: [AVSB_TEMPLATE_FEATURES] })
 * ```
 */
export const AVSB_TEMPLATE_FEATURES = [
  AvsbFlagDirective,
  AvsbExposureDirective,
  AvsbFlagPipe,
  AvsbFlagStatePipe,
] as const

/** Mode B: the caller supplied a client, so this package must not build one. */
function isInjectedClientConfig(
  config: AvsbConfig
): config is { client: AngularAvsbClient } {
  return 'client' in config && config.client !== undefined
}

/** The providers behind both `provideAvsb()` and `AvsbModule.forRoot()`. */
function avsbProviders(config: AvsbConfig): Provider[] {
  return [
    { provide: AVSB_CONFIG, useValue: config },
    {
      provide: AVSB_CLIENT,
      useFactory: (): AngularAvsbClient => {
        // Mode B: a pre-built client. Its lifecycle stays with the caller.
        if (isInjectedClientConfig(config)) return config.client
        // Mode A: build one from the options. `AvsbClient` satisfies
        // `AngularAvsbClient` structurally, so drift between the two shows up
        // here as a compile error rather than as a runtime surprise.
        // Report @avsbhq/angular on the heartbeat, not @avsbhq/browser (N1-14).
        return new AvsbClient({
          ...config,
          wrapper: config.wrapper ?? { sdkType: SDK_TYPE, sdkVersion: SDK_VERSION },
        })
      },
    },
    {
      // A factory rather than a bare class provider, so nothing here depends
      // on DI reflection: the service reads its two tokens with `inject()`,
      // and a factory is an injection context in every build mode.
      provide: AvsbService,
      useFactory: (): AvsbService => new AvsbService(),
    },
  ]
}

/**
 * Configure the A vs B SDK for a standalone application.
 *
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideAvsb({
 *       sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
 *       context: { kind: 'user', key: 'anon_42' },
 *     }),
 *   ],
 * })
 * ```
 *
 * Call it once, at bootstrap. Calling it again in a lazy route's providers
 * creates a SECOND client scoped to that route: deliberate when you want a
 * different context there, a duplicate datafile fetch when you do not.
 */
export function provideAvsb(config: AvsbConfig): EnvironmentProviders {
  return makeEnvironmentProviders(avsbProviders(config))
}

/**
 * The NgModule entry point, for applications that have not moved to
 * standalone bootstrap.
 *
 * ```ts
 * @NgModule({
 *   imports: [BrowserModule, AvsbModule.forRoot({ sdkKey: 'sdk_...' })],
 * })
 * export class AppModule {}
 * ```
 *
 * Importing `AvsbModule` without `forRoot()` (in a feature module) gives
 * that module the directives and pipes without configuring a second client.
 */
@NgModule({
  imports: [
    AvsbFlagDirective,
    AvsbExposureDirective,
    AvsbFlagPipe,
    AvsbFlagStatePipe,
  ],
  exports: [
    AvsbFlagDirective,
    AvsbExposureDirective,
    AvsbFlagPipe,
    AvsbFlagStatePipe,
  ],
})
export class AvsbModule {
  static forRoot(config: AvsbConfig): ModuleWithProviders<AvsbModule> {
    return {
      ngModule: AvsbModule,
      providers: avsbProviders(config),
    }
  }
}
