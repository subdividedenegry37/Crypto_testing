// Small, high-liquidity mainnet set for low-rate simulation.
// Each non-WETH token has a WETH pair on both Uniswap V2 and Sushiswap.
module.exports = [
  { symbol: "WETH",  address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase(), decimals: 18 },
  { symbol: "USDC",  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48".toLowerCase(), decimals: 6 },
  { symbol: "DAI",   address: "0x6B175474E89094C44Da98b954EedeAC495271d0F".toLowerCase(), decimals: 18 },
  { symbol: "WBTC",  address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599".toLowerCase(), decimals: 8 },
  { symbol: "USDT",  address: "0xdAC17F958D2ee523a2206206994597C13D831ec7".toLowerCase(), decimals: 6 }
];