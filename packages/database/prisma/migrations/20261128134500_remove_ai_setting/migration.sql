-- The last legacy AI table. STT now lives in the `STT_*` environment
-- variables, and every other AI column was already unused after Eve replaced
-- the old Soul/agent/automation/bot stack.
DROP TABLE "AiSetting";
