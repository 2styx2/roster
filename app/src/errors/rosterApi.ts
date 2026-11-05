// The connected roster's `api_version`, for the error panels' words: a fix that names a command
// says it the way that roster takes it (`roster setup --host` from API 29, #461). The App provides
// it once serve is up; without it a panel says what a roster that has everything takes.
import { createContext } from "react";

export const RosterApi = createContext<number | undefined>(undefined);
