/**
 * @license Copyright 2022 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import * as td from 'testdouble';

import {
  createMockDriver,
  mockDriverModule,
  mockRunnerModule,
} from './mock-driver.js';

const mockRunner = await mockRunnerModule();

// Establish the mocks before we import the file under test.
/** @type {ReturnType<typeof createMockDriver>} */
const mockDriver = createMockDriver();

await td.replaceEsm('../../../fraggle-rock/gather/driver.js',
  mockDriverModule(() => testContext.mockDriver.asDriver()));

/** @typedef {typeof testContext} TestContext */
const testContext = {
  mockRunner,
  mockDriver,
};
export {testContext};