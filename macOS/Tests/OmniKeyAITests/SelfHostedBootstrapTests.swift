import Foundation
import XCTest
@testable import OmniKeyAI

final class SelfHostedBootstrapTests: XCTestCase {
    func testValidConfiguredPortsDoNotDependOnDaemonAvailability() {
        // Configured installations are recognized without a health request:
        // slow startup, refused connections, and an offline daemon are not onboarding.
        for json in [#"{"OMNIKEY_PORT":7071}"#, #"{"OMNIKEY_PORT":" 7071 "}"#] {
            XCTAssertEqual(SelfHostedBootstrap.configuredDaemonPort(in: Data(json.utf8)), 7071)
        }
        XCTAssertEqual(SelfHostedBootstrap.configuredDaemonPort(in: Data(#"{"OMNIKEY_PORT":65535}"#.utf8)), 65535)
    }

    func testConfiguredInstallationSkipsOnboardingWithoutProbingDaemon() {
        let completed = expectation(description: "configuration gate")
        SelfHostedBootstrap.shouldShowFirstRunOnboarding(configuredPort: { 65534 }) { shouldShow in
            XCTAssertTrue(Thread.isMainThread)
            XCTAssertFalse(shouldShow)
            completed.fulfill()
        }
        wait(for: [completed], timeout: 2)
    }

    func testUnconfiguredInstallationShowsOnboarding() {
        let completed = expectation(description: "first-run gate")
        SelfHostedBootstrap.shouldShowFirstRunOnboarding(configuredPort: { nil }) { shouldShow in
            XCTAssertTrue(Thread.isMainThread)
            XCTAssertTrue(shouldShow)
            completed.fulfill()
        }
        wait(for: [completed], timeout: 2)
    }

    func testMissingMalformedAndInvalidPortsRequireConfiguration() {
        for json in ["not json", "[]", "{}", #"{"OMNIKEY_PORT":true}"#,
                     #"{"OMNIKEY_PORT":0}"#, #"{"OMNIKEY_PORT":-1}"#,
                     #"{"OMNIKEY_PORT":65536}"#, #"{"OMNIKEY_PORT":7071.5}"#,
                     #"{"OMNIKEY_PORT":"bad"}"#, #"{"OMNIKEY_PORT":"65536"}"#] {
            XCTAssertNil(SelfHostedBootstrap.configuredDaemonPort(in: Data(json.utf8)), json)
        }
    }
}
