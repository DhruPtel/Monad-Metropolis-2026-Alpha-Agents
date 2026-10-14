// Written by pnpm deploy:l2 base-sepolia (CO-U1); do not edit by hand.
export const DEPLOYMENT = {
  chainId: 84532,
  block: 48119589,
  contracts: {
    usdc: {
      address: "0xB9f81f8aD949Ed369f56003Da3d98d097224Ebda",
      codeSize: 2149,
    },
    agent_nft: {
      address: "0x6Fbf9065B5aE69a9618F898ba6A89C9c0b1397db",
      codeSize: 5241,
    },
    uniswap_v3_pool_usdc_weth_500: {
      address: "0x6DF3a6ddaF73C9EDCea165e0eCA9f4006c00bb8f",
      codeSize: 22142,
    },
    token_registry_v3: {
      address: "0xD66f145B8B6c4fc44133d6F1EA48cD41BAf21008",
      codeSize: 9499,
    },
    route_adapter_v3: {
      address: "0xe21c4B9BBde1EfE617D2eC77226599c66b1EA81A",
      codeSize: 6135,
    },
    executor_v3: {
      address: "0x1335d659Fb202366ded6E7c089d9FAea618081A4",
      codeSize: 24139,
    },
    executor_route_adapter_v3: {
      address: "0x0D91231485B1EE60cd589335AB06bBA6f954CAA9",
      codeSize: 6135,
    },
    protocol_registry_v3: {
      address: "0x6685695b095AD533162f4498858F659D5bc17f19",
      codeSize: 11478,
    },
    oracle_adapter_v3: {
      address: "0x7BCa2CAA53605BDF8f3264F2F94Cd8B4FC412220",
      codeSize: 5286,
    },
    account_factory_v3: {
      address: "0x43E5F10d94CA395D0d466F5170b448784a181cfC",
      codeSize: 7056,
    },
    personal_account_v3_implementation: {
      address: "0x96A882E2Bcc7936b944FE0d4ecB7794a6C2b8d82",
      codeSize: 22344,
    },
  },
  external: {
    wmon: "0x4200000000000000000000000000000000000006",
    chainlink_eth_usd: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
    chainlink_usdc_usd: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165",
    uniswap_v3_factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    uniswap_v3_swap_router02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    uniswap_v3_quoter_v2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
    uniswap_v3_position_manager: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
    pyth_entropy: "0x41c9e39574F40Ad34c79f1C99B66A45eFB830d4c",
    create2_deployer: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
  },
} as const;
