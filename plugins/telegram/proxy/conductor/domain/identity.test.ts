import { describe, expect, test } from 'bun:test'
import { admit, policyProblem } from './identity'

const policy = { selfNodeId: 'nSELF', operatorLogin: 'operator@example.com', allowedNodes: new Set(['nPHONE']) }

describe('admit', () => {
  test('the operator\'s allowed device is admitted', () => {
    expect(admit({ nodeId: 'nPHONE', login: 'Operator@Example.com' }, policy)).toEqual({ admitted: true, nodeId: 'nPHONE' })
  })

  test('this machine is refused although it belongs to the operator: an agent here would otherwise pass', () => {
    expect(admit({ nodeId: 'nSELF', login: 'operator@example.com' }, policy)).toEqual({ admitted: false, refusal: 'own_node' })
  })

  test('another user, another of the operator\'s nodes, and an unknown peer are refused', () => {
    expect(admit({ nodeId: 'nPHONE', login: 'guest@example.com' }, policy)).toEqual({ admitted: false, refusal: 'not_operator' })
    expect(admit({ nodeId: 'nLAPTOP', login: 'operator@example.com' }, policy)).toEqual({ admitted: false, refusal: 'node_not_allowed' })
    expect(admit(null, policy)).toEqual({ admitted: false, refusal: 'unknown_peer' })
  })
})

test('a policy that could admit this machine, or no one, is a boot error', () => {
  expect(policyProblem(policy)).toBeUndefined()
  expect(policyProblem({ ...policy, allowedNodes: new Set(['nPHONE', 'nSELF']) })).toContain('own node')
  expect(policyProblem({ ...policy, allowedNodes: new Set() })).toContain('empty')
  expect(policyProblem({ ...policy, selfNodeId: '' })).toContain('unknown')
  expect(policyProblem({ ...policy, operatorLogin: '' })).toContain('operator login')
})
