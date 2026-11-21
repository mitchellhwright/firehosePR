import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyGeneratedSwiftChange } from '../../scripts/swift-test-impact.ts';

const header = `//
//  Generated - DO NOT EDIT
//

import Foundation

`;

const memberwiseStruct = `/// A payload with a memberwise init.
public struct DebtSummary: Codable, Equatable, Hashable, Sendable {
    /// Total outstanding debt.
    public var totalDebtBalance: Double
    public var dtiRatio: Double?

    public init(
        totalDebtBalance: Double,
        dtiRatio: Double? = nil
    ) {
        self.totalDebtBalance = totalDebtBalance
        self.dtiRatio = dtiRatio
    }
}
`;

const plainStruct = `public struct NetWorthPayload: Codable, Equatable, Hashable, Sendable {
    public var totalAssets: Double
    public var totalLiabilities: Double
    public var percentChange: Double?
}
`;

const stringEnum = `/// Where a category came from.
public enum CategorySource: String, Codable, CaseIterable, Sendable {
    case plaid = "plaid"
    case user = "user"
    case system = "system"
}
`;

const tolerantEnum = `public enum BudgetRangeStatus: RawRepresentable, Codable, CaseIterable, Hashable, Sendable {
    case under
    case over
    /// A raw value this app version does not know, kept verbatim so it round-trips unchanged.
    case unrecognizedValue(String)

    public static let allCases: [BudgetRangeStatus] = [
        .under,
        .over,
    ]

    public init?(rawValue: String) {
        switch rawValue {
        case "under": self = .under
        case "over": self = .over
        default: return nil
        }
    }

    public var rawValue: String {
        switch self {
        case .under: return "under"
        case .over: return "over"
        case .unrecognizedValue(let rawValue): return rawValue
        }
    }
}
`;

const before = `${header}${memberwiseStruct}\n${plainStruct}\n${stringEnum}\n${tolerantEnum}`;

function additive(after: string) {
  const change = classifyGeneratedSwiftChange(before, after);
  assert.equal(change.kind, 'additive', JSON.stringify(change));
  return change.kind === 'additive' ? change : assert.fail('unreachable');
}

function notAdditive(after: string, reason: RegExp): void {
  const change = classifyGeneratedSwiftChange(before, after);
  assert.equal(change.kind, 'not-additive', JSON.stringify(change));
  if (change.kind === 'not-additive') assert.match(change.reason, reason);
}

describe('classifyGeneratedSwiftChange', () => {
  it('treats documentation-only edits as no executable change', () => {
    const after = before.replace('/// Total outstanding debt.', '/// Total outstanding debt, in dollars.');
    assert.deepEqual(classifyGeneratedSwiftChange(before, after), { kind: 'documentation' });
    assert.deepEqual(classifyGeneratedSwiftChange(before, before), { kind: 'documentation' });
  });

  it('accepts an optional field with its memberwise init plumbing, including the trailing-comma rewrite', () => {
    const after = before
      .replace('    public var dtiRatio: Double?\n', '    public var dtiRatio: Double?\n    /// Absent means true.\n    public var balancesComplete: Bool?\n')
      .replace('        dtiRatio: Double? = nil\n', '        dtiRatio: Double? = nil,\n        balancesComplete: Bool? = nil\n')
      .replace('        self.dtiRatio = dtiRatio\n', '        self.dtiRatio = dtiRatio\n        self.balancesComplete = balancesComplete\n');
    const change = additive(after);
    assert.deepEqual(change.addedOptionalFields, { 'struct:DebtSummary': ['balancesComplete'] });
    assert.deepEqual(change.addedEnumCases, {});
    assert.deepEqual(change.addedDeclarations, []);
    assert.deepEqual(change.typeNames, ['DebtSummary']);
  });

  it('accepts an optional field on a struct without an init', () => {
    const after = before.replace('    public var percentChange: Double?\n', '    public var percentChange: Double?\n    public var unavailable: [NetWorthUnavailableBalance]?\n');
    const change = additive(after);
    assert.deepEqual(change.addedOptionalFields, { 'struct:NetWorthPayload': ['unavailable'] });
  });

  it('accepts new top-level types and names them', () => {
    const after = before.replace(`${plainStruct}\n`, `${plainStruct}\npublic struct NetWorthUnavailableBalance: Codable, Equatable, Hashable, Sendable {
    public var name: String
    public var side: String
}

`);
    const change = additive(after);
    assert.deepEqual(change.addedDeclarations, ['struct:NetWorthUnavailableBalance']);
    assert.deepEqual(change.typeNames, ['NetWorthUnavailableBalance']);
  });

  it('accepts a new string-backed case, but not one that reorders the existing cases', () => {
    const added = before.replace('    case system = "system"\n', '    case system = "system"\n    case rule = "rule"\n');
    assert.deepEqual(additive(added).addedEnumCases, { 'enum:CategorySource': ['rule'] });
    const reordered = before.replace('    case plaid = "plaid"\n    case user = "user"\n    case system = "system"\n',
      '    case rule = "rule"\n    case system = "system"\n    case plaid = "plaid"\n    case user = "user"\n');
    notAdditive(reordered, /CategorySource cases were reordered, which changes allCases order/);
  });

  it('accepts a tolerant enum case only with all four of its entries', () => {
    const complete = before
      .replace('    case over\n', '    case over\n    case neutral\n')
      .replace('        .over,\n', '        .over,\n        .neutral,\n')
      .replace('        case "over": self = .over\n', '        case "over": self = .over\n        case "neutral": self = .neutral\n')
      .replace('        case .over: return "over"\n', '        case .over: return "over"\n        case .neutral: return "neutral"\n');
    assert.deepEqual(additive(complete).addedEnumCases, { 'enum:BudgetRangeStatus': ['neutral'] });
    const withoutEncode = complete.replace('        case .neutral: return "neutral"\n', '');
    notAdditive(withoutEncode, /BudgetRangeStatus\.neutral lacks its decode, encode or allCases entry/);
    const decodeOnly = before.replace('        case "over": self = .over\n', '        case "over": self = .over\n        case "neutral": self = .neutral\n');
    notAdditive(decodeOnly, /BudgetRangeStatus changed without adding a case/);
    const strayAllCases = complete.replace('    case neutral\n', '').replace('        case "neutral": self = .neutral\n', '')
      .replace('        case .neutral: return "neutral"\n', '')
      .replace('    case over\n', '    case caution\n    case over\n');
    notAdditive(strayAllCases, /BudgetRangeStatus\.caution lacks its decode, encode or allCases entry/);
  });

  it('rejects removed, retyped, optionalized and required members', () => {
    notAdditive(before.replace('    public var percentChange: Double?\n', ''), /NetWorthPayload lost a line: public var percentChange: Double\?/);
    notAdditive(before.replace('    public var totalAssets: Double\n', '    public var totalAssets: Int\n'), /NetWorthPayload lost a line: public var totalAssets: Double/);
    notAdditive(before.replace('    public var totalAssets: Double\n', '    public var totalAssets: Double?\n'), /NetWorthPayload lost a line: public var totalAssets: Double$/);
    notAdditive(before.replace('    public var percentChange: Double?\n', '    public var percentChange: Double?\n    public var status: String\n'),
      /NetWorthPayload gained a non-optional member: public var status: String/);
    notAdditive(before.replace('    public var dtiRatio: Double?\n', '    public var dtiRatio: Double?\n    public var balancesComplete: Bool?\n'),
      /DebtSummary\.balancesComplete lacks its memberwise init plumbing/);
  });

  it('rejects removed or renamed declarations, reordered declarations and code outside them', () => {
    notAdditive(before.replace(`${plainStruct}\n`, ''), /removed declaration struct:NetWorthPayload/);
    notAdditive(before.replace('public struct NetWorthPayload:', 'public struct NetWorthSummaryPayload:'), /removed declaration struct:NetWorthPayload/);
    notAdditive(`${header}${plainStruct}\n${memberwiseStruct}\n${stringEnum}\n${tolerantEnum}`, /top-level declarations were reordered/);
    notAdditive(before.replace('import Foundation\n', 'import Foundation\nimport Combine\n'), /code outside the top-level declarations changed/);
    notAdditive(`${before}\nextension NetWorthPayload {\n    public var isEmpty: Bool { totalAssets == 0 }\n}\n`, /code outside the top-level declarations changed/);
  });

  it('rejects removed, renamed or raw-less enum cases and non-string enums', () => {
    notAdditive(before.replace('    case user = "user"\n', ''), /CategorySource lost a line: case user = "user"/);
    notAdditive(before.replace('    case user = "user"\n', '    case user = "person"\n'), /CategorySource lost a line: case user = "user"/);
    notAdditive(before.replace('    case system = "system"\n', '    case system = "system"\n    case rule\n'), /CategorySource gained a line that is not a new case: case rule/);
    notAdditive(before.replace('    case system = "system"\n', '    case system = "system"\n    case plaid = "plaid_v2"\n'), /CategorySource\.plaid or its raw value already existed/);
    const intEnum = `${before}\npublic enum Level: Int, Codable, CaseIterable, Sendable {\n    case one = 1\n}\n`;
    const intEnumGrown = intEnum.replace('    case one = 1\n', '    case one = 1\n    case two = 2\n');
    assert.equal(classifyGeneratedSwiftChange(intEnum, intEnumGrown).kind, 'not-additive');
  });

  it('rejects files it cannot parse into declarations', () => {
    notAdditive(header, /no parsable top-level declarations/);
  });
});
